//! Odyssey Design — the spreadsheet formula engine.
//!
//! A recursive-descent parser over a small expression grammar, evaluated
//! against a sparse cell map. Deliberately not a Excel-compatibility project:
//! it covers arithmetic, comparisons, cell refs, ranges and the function set
//! people actually reach for, and it detects reference cycles instead of
//! hanging on them.
//!
//! Grammar (lowest precedence first):
//!   expr    := compare
//!   compare := sum (("="|"<>"|"<"|"<="|">"|">=") sum)*
//!   sum     := product (("+"|"-"|"&") product)*
//!   product := unary (("*"|"/") unary)*
//!   unary   := ("-"|"+")? power
//!   power   := atom ("^" unary)?
//!   atom    := number | string | ref | range | call | "(" expr ")"

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", content = "v", rename_all = "lowercase")]
pub enum Value {
    Number(f64),
    Text(String),
    Bool(bool),
    /// #DIV/0!, #REF!, #CYCLE! and friends. Errors are values, so one bad cell
    /// poisons only the cells that depend on it.
    Error(String),
    Empty,
}

impl Value {
    pub fn as_number(&self) -> Result<f64, Value> {
        match self {
            Value::Number(n) => Ok(*n),
            Value::Bool(b) => Ok(if *b { 1.0 } else { 0.0 }),
            Value::Empty => Ok(0.0),
            Value::Text(s) => s
                .trim()
                .parse::<f64>()
                .map_err(|_| Value::Error("#VALUE!".into())),
            Value::Error(_) => Err(self.clone()),
        }
    }

    pub fn display(&self) -> String {
        match self {
            Value::Number(n) => {
                if n.fract() == 0.0 && n.abs() < 1e15 {
                    format!("{}", *n as i64)
                } else {
                    let s = format!("{n:.10}");
                    let s = s.trim_end_matches('0').trim_end_matches('.').to_string();
                    s
                }
            }
            Value::Text(s) => s.clone(),
            Value::Bool(b) => if *b { "TRUE" } else { "FALSE" }.into(),
            Value::Error(e) => e.clone(),
            Value::Empty => String::new(),
        }
    }
}

/// A1-style address. Zero-based internally.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Addr {
    pub col: u32,
    pub row: u32,
}

impl Addr {
    pub fn parse(s: &str) -> Option<Addr> {
        let s = s.trim().trim_start_matches('$');
        let split = s.find(|c: char| c.is_ascii_digit())?;
        let (letters, digits) = s.split_at(split);
        let digits = digits.trim_start_matches('$');
        if letters.is_empty() || digits.is_empty() {
            return None;
        }
        let mut col: u32 = 0;
        for ch in letters.chars() {
            if !ch.is_ascii_alphabetic() {
                return None;
            }
            col = col
                .checked_mul(26)?
                .checked_add(ch.to_ascii_uppercase() as u32 - 'A' as u32 + 1)?;
        }
        let row: u32 = digits.parse().ok()?;
        if row == 0 {
            return None;
        }
        Some(Addr { col: col - 1, row: row - 1 })
    }

    pub fn to_a1(self) -> String {
        let mut col = self.col + 1;
        let mut letters = String::new();
        while col > 0 {
            let rem = ((col - 1) % 26) as u8;
            letters.insert(0, (b'A' + rem) as char);
            col = (col - 1) / 26;
        }
        format!("{letters}{}", self.row + 1)
    }
}

/// The sheet itself: a sparse map of raw cell input, exactly as typed.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct Sheet {
    /// Keyed by A1 address so the JSON is human-readable on disk.
    pub cells: HashMap<String, String>,
}

impl Sheet {
    pub fn set(&mut self, addr: &str, raw: &str) {
        if raw.is_empty() {
            self.cells.remove(&addr.to_ascii_uppercase());
        } else {
            self.cells.insert(addr.to_ascii_uppercase(), raw.to_string());
        }
    }

    pub fn raw(&self, addr: Addr) -> Option<&str> {
        self.cells.get(&addr.to_a1()).map(String::as_str)
    }

    /// Evaluate every populated cell. Returns A1 -> computed value.
    pub fn evaluate_all(&self) -> HashMap<String, Value> {
        let mut out = HashMap::new();
        for key in self.cells.keys() {
            if let Some(addr) = Addr::parse(key) {
                let mut visiting = HashSet::new();
                let v = self.eval_addr(addr, &mut visiting);
                out.insert(addr.to_a1(), v);
            }
        }
        out
    }

    pub fn eval_cell(&self, addr: Addr) -> Value {
        let mut visiting = HashSet::new();
        self.eval_addr(addr, &mut visiting)
    }

    fn eval_addr(&self, addr: Addr, visiting: &mut HashSet<Addr>) -> Value {
        let Some(raw) = self.raw(addr) else {
            return Value::Empty;
        };
        if !visiting.insert(addr) {
            // We are already computing this cell further up the stack.
            return Value::Error("#CYCLE!".into());
        }
        let result = self.eval_raw(raw, visiting);
        visiting.remove(&addr);
        result
    }

    fn eval_raw(&self, raw: &str, visiting: &mut HashSet<Addr>) -> Value {
        let trimmed = raw.trim();
        if let Some(formula) = trimmed.strip_prefix('=') {
            let mut p = Parser::new(formula);
            match p.parse_expr() {
                Ok(node) => {
                    if !p.at_end() {
                        return Value::Error("#PARSE!".into());
                    }
                    self.eval_node(&node, visiting)
                }
                Err(e) => Value::Error(e),
            }
        } else if let Ok(n) = trimmed.parse::<f64>() {
            Value::Number(n)
        } else if trimmed.eq_ignore_ascii_case("true") {
            Value::Bool(true)
        } else if trimmed.eq_ignore_ascii_case("false") {
            Value::Bool(false)
        } else {
            Value::Text(raw.to_string())
        }
    }

    fn eval_node(&self, node: &Node, visiting: &mut HashSet<Addr>) -> Value {
        match node {
            Node::Number(n) => Value::Number(*n),
            Node::Text(s) => Value::Text(s.clone()),
            Node::Ref(a) => self.eval_addr(*a, visiting),
            Node::Range(_, _) => Value::Error("#VALUE!".into()), // a bare range is not a scalar
            Node::Unary(op, inner) => {
                let v = self.eval_node(inner, visiting);
                match v.as_number() {
                    Err(e) => e,
                    Ok(n) => Value::Number(if *op == '-' { -n } else { n }),
                }
            }
            Node::Binary(op, l, r) => self.eval_binary(*op, l, r, visiting),
            Node::Call(name, args) => self.eval_call(name, args, visiting),
        }
    }

    fn eval_binary(&self, op: Op, l: &Node, r: &Node, visiting: &mut HashSet<Addr>) -> Value {
        let lv = self.eval_node(l, visiting);
        let rv = self.eval_node(r, visiting);
        if let Value::Error(_) = lv {
            return lv;
        }
        if let Value::Error(_) = rv {
            return rv;
        }
        if op == Op::Concat {
            return Value::Text(format!("{}{}", lv.display(), rv.display()));
        }
        if matches!(op, Op::Eq | Op::Ne) {
            // Equality compares text as text, numbers as numbers.
            let equal = match (&lv, &rv) {
                (Value::Text(a), Value::Text(b)) => a == b,
                _ => match (lv.as_number(), rv.as_number()) {
                    (Ok(a), Ok(b)) => a == b,
                    _ => lv.display() == rv.display(),
                },
            };
            return Value::Bool(if op == Op::Eq { equal } else { !equal });
        }
        let (a, b) = match (lv.as_number(), rv.as_number()) {
            (Ok(a), Ok(b)) => (a, b),
            (Err(e), _) | (_, Err(e)) => return e,
        };
        match op {
            Op::Add => Value::Number(a + b),
            Op::Sub => Value::Number(a - b),
            Op::Mul => Value::Number(a * b),
            Op::Div => {
                if b == 0.0 {
                    Value::Error("#DIV/0!".into())
                } else {
                    Value::Number(a / b)
                }
            }
            Op::Pow => Value::Number(a.powf(b)),
            Op::Lt => Value::Bool(a < b),
            Op::Le => Value::Bool(a <= b),
            Op::Gt => Value::Bool(a > b),
            Op::Ge => Value::Bool(a >= b),
            Op::Eq | Op::Ne | Op::Concat => unreachable!("handled above"),
        }
    }

    /// Flatten arguments, expanding ranges into their cell values.
    fn spread(&self, args: &[Node], visiting: &mut HashSet<Addr>) -> Vec<Value> {
        let mut out = Vec::new();
        for arg in args {
            match arg {
                Node::Range(a, b) => {
                    for addr in cells_in(*a, *b) {
                        out.push(self.eval_addr(addr, visiting));
                    }
                }
                other => out.push(self.eval_node(other, visiting)),
            }
        }
        out
    }

    fn eval_call(&self, name: &str, args: &[Node], visiting: &mut HashSet<Addr>) -> Value {
        let upper = name.to_ascii_uppercase();

        // IF must not evaluate the branch it does not take.
        if upper == "IF" {
            if args.len() < 2 || args.len() > 3 {
                return Value::Error("#N/ARGS!".into());
            }
            let cond = self.eval_node(&args[0], visiting);
            if let Value::Error(_) = cond {
                return cond;
            }
            let truthy = match &cond {
                Value::Bool(b) => *b,
                other => match other.as_number() {
                    Ok(n) => n != 0.0,
                    Err(e) => return e,
                },
            };
            return if truthy {
                self.eval_node(&args[1], visiting)
            } else if args.len() == 3 {
                self.eval_node(&args[2], visiting)
            } else {
                Value::Bool(false)
            };
        }

        let vals = self.spread(args, visiting);
        if let Some(err) = vals.iter().find(|v| matches!(v, Value::Error(_))) {
            return err.clone();
        }
        // Numeric aggregates skip blanks and text, matching spreadsheet convention.
        let nums: Vec<f64> = vals
            .iter()
            .filter(|v| !matches!(v, Value::Empty | Value::Text(_)))
            .filter_map(|v| v.as_number().ok())
            .collect();

        match upper.as_str() {
            "SUM" => Value::Number(nums.iter().sum()),
            "PRODUCT" => Value::Number(nums.iter().product()),
            "AVERAGE" | "MEAN" => {
                if nums.is_empty() {
                    Value::Error("#DIV/0!".into())
                } else {
                    Value::Number(nums.iter().sum::<f64>() / nums.len() as f64)
                }
            }
            "MIN" => nums
                .iter()
                .copied()
                .fold(None, |acc: Option<f64>, n| Some(acc.map_or(n, |a| a.min(n))))
                .map_or(Value::Number(0.0), Value::Number),
            "MAX" => nums
                .iter()
                .copied()
                .fold(None, |acc: Option<f64>, n| Some(acc.map_or(n, |a| a.max(n))))
                .map_or(Value::Number(0.0), Value::Number),
            "COUNT" => Value::Number(nums.len() as f64),
            "COUNTA" => Value::Number(vals.iter().filter(|v| !matches!(v, Value::Empty)).count() as f64),
            "ROUND" => {
                if nums.len() != 2 {
                    return Value::Error("#N/ARGS!".into());
                }
                let factor = 10f64.powi(nums[1] as i32);
                Value::Number((nums[0] * factor).round() / factor)
            }
            "ABS" => one(&nums, f64::abs),
            "SQRT" => {
                if nums.len() != 1 {
                    Value::Error("#N/ARGS!".into())
                } else if nums[0] < 0.0 {
                    Value::Error("#NUM!".into())
                } else {
                    Value::Number(nums[0].sqrt())
                }
            }
            "FLOOR" => one(&nums, f64::floor),
            "CEILING" | "CEIL" => one(&nums, f64::ceil),
            "LEN" => Value::Number(vals.first().map_or(0.0, |v| v.display().chars().count() as f64)),
            "UPPER" => Value::Text(vals.first().map_or(String::new(), |v| v.display().to_uppercase())),
            "LOWER" => Value::Text(vals.first().map_or(String::new(), |v| v.display().to_lowercase())),
            "CONCAT" | "CONCATENATE" => {
                Value::Text(vals.iter().map(Value::display).collect::<String>())
            }
            "NOT" => match vals.first().map(Value::as_number) {
                Some(Ok(n)) => Value::Bool(n == 0.0),
                _ => Value::Error("#VALUE!".into()),
            },
            "AND" => Value::Bool(nums.iter().all(|n| *n != 0.0)),
            "OR" => Value::Bool(nums.iter().any(|n| *n != 0.0)),
            _ => Value::Error("#NAME?".into()),
        }
    }
}

fn one(nums: &[f64], f: fn(f64) -> f64) -> Value {
    if nums.len() != 1 {
        Value::Error("#N/ARGS!".into())
    } else {
        Value::Number(f(nums[0]))
    }
}

/// Every address in the rectangle, capped so `A1:XFD1048576` cannot hang the UI.
fn cells_in(a: Addr, b: Addr) -> Vec<Addr> {
    const MAX_RANGE_CELLS: usize = 250_000;
    let (c0, c1) = (a.col.min(b.col), a.col.max(b.col));
    let (r0, r1) = (a.row.min(b.row), a.row.max(b.row));
    let mut out = Vec::new();
    for row in r0..=r1 {
        for col in c0..=c1 {
            if out.len() >= MAX_RANGE_CELLS {
                return out;
            }
            out.push(Addr { col, row });
        }
    }
    out
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Op {
    Add, Sub, Mul, Div, Pow, Concat,
    Eq, Ne, Lt, Le, Gt, Ge,
}

#[derive(Debug, Clone)]
enum Node {
    Number(f64),
    Text(String),
    Ref(Addr),
    Range(Addr, Addr),
    Unary(char, Box<Node>),
    Binary(Op, Box<Node>, Box<Node>),
    Call(String, Vec<Node>),
}

struct Parser {
    src: Vec<char>,
    pos: usize,
    depth: u32,
}

impl Parser {
    fn new(s: &str) -> Parser {
        Parser { src: s.chars().collect(), pos: 0, depth: 0 }
    }

    fn at_end(&mut self) -> bool {
        self.skip_ws();
        self.pos >= self.src.len()
    }

    fn skip_ws(&mut self) {
        while self.pos < self.src.len() && self.src[self.pos].is_whitespace() {
            self.pos += 1;
        }
    }

    fn peek(&mut self) -> Option<char> {
        self.skip_ws();
        self.src.get(self.pos).copied()
    }

    fn eat(&mut self, c: char) -> bool {
        if self.peek() == Some(c) {
            self.pos += 1;
            true
        } else {
            false
        }
    }

    fn parse_expr(&mut self) -> Result<Node, String> {
        // Bound recursion so a crafted formula cannot blow the stack (§8.4).
        self.depth += 1;
        if self.depth > 64 {
            return Err("#DEPTH!".into());
        }
        let node = self.parse_compare();
        self.depth -= 1;
        node
    }

    fn parse_compare(&mut self) -> Result<Node, String> {
        let mut left = self.parse_sum()?;
        loop {
            self.skip_ws();
            let op = match (self.src.get(self.pos), self.src.get(self.pos + 1)) {
                (Some('<'), Some('>')) => { self.pos += 2; Op::Ne }
                (Some('<'), Some('=')) => { self.pos += 2; Op::Le }
                (Some('>'), Some('=')) => { self.pos += 2; Op::Ge }
                (Some('<'), _) => { self.pos += 1; Op::Lt }
                (Some('>'), _) => { self.pos += 1; Op::Gt }
                (Some('='), _) => { self.pos += 1; Op::Eq }
                _ => break,
            };
            let right = self.parse_sum()?;
            left = Node::Binary(op, Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn parse_sum(&mut self) -> Result<Node, String> {
        let mut left = self.parse_product()?;
        loop {
            let op = match self.peek() {
                Some('+') => Op::Add,
                Some('-') => Op::Sub,
                Some('&') => Op::Concat,
                _ => break,
            };
            self.pos += 1;
            let right = self.parse_product()?;
            left = Node::Binary(op, Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn parse_product(&mut self) -> Result<Node, String> {
        let mut left = self.parse_unary()?;
        loop {
            let op = match self.peek() {
                Some('*') => Op::Mul,
                Some('/') => Op::Div,
                _ => break,
            };
            self.pos += 1;
            let right = self.parse_unary()?;
            left = Node::Binary(op, Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn parse_unary(&mut self) -> Result<Node, String> {
        match self.peek() {
            Some('-') => { self.pos += 1; Ok(Node::Unary('-', Box::new(self.parse_unary()?))) }
            Some('+') => { self.pos += 1; self.parse_unary() }
            _ => self.parse_power(),
        }
    }

    fn parse_power(&mut self) -> Result<Node, String> {
        let base = self.parse_atom()?;
        if self.eat('^') {
            let exp = self.parse_unary()?;
            return Ok(Node::Binary(Op::Pow, Box::new(base), Box::new(exp)));
        }
        Ok(base)
    }

    fn parse_atom(&mut self) -> Result<Node, String> {
        let c = self.peek().ok_or("#PARSE!")?;

        if c == '(' {
            self.pos += 1;
            let inner = self.parse_expr()?;
            if !self.eat(')') {
                return Err("#PARSE!".into());
            }
            return Ok(inner);
        }

        if c == '"' {
            self.pos += 1;
            let mut s = String::new();
            while let Some(&ch) = self.src.get(self.pos) {
                self.pos += 1;
                if ch == '"' {
                    // "" inside a string is an escaped quote.
                    if self.src.get(self.pos) == Some(&'"') {
                        s.push('"');
                        self.pos += 1;
                        continue;
                    }
                    return Ok(Node::Text(s));
                }
                s.push(ch);
            }
            return Err("#PARSE!".into());
        }

        if c.is_ascii_digit() || c == '.' {
            let start = self.pos;
            while let Some(&ch) = self.src.get(self.pos) {
                if ch.is_ascii_digit() || ch == '.' {
                    self.pos += 1;
                } else {
                    break;
                }
            }
            let text: String = self.src[start..self.pos].iter().collect();
            return text.parse::<f64>().map(Node::Number).map_err(|_| "#NUM!".to_string());
        }

        if c.is_ascii_alphabetic() || c == '$' || c == '_' {
            let start = self.pos;
            while let Some(&ch) = self.src.get(self.pos) {
                if ch.is_ascii_alphanumeric() || ch == '$' || ch == '_' || ch == '.' {
                    self.pos += 1;
                } else {
                    break;
                }
            }
            let word: String = self.src[start..self.pos].iter().collect();

            // A name followed by '(' is a function call.
            if self.peek() == Some('(') {
                self.pos += 1;
                let mut args = Vec::new();
                if self.peek() != Some(')') {
                    loop {
                        args.push(self.parse_expr()?);
                        if self.eat(',') {
                            continue;
                        }
                        break;
                    }
                }
                if !self.eat(')') {
                    return Err("#PARSE!".into());
                }
                return Ok(Node::Call(word, args));
            }

            // Otherwise a cell reference, possibly the start of a range.
            let Some(addr) = Addr::parse(&word) else {
                return Err("#NAME?".into());
            };
            if self.peek() == Some(':') {
                self.pos += 1;
                let start2 = self.pos;
                while let Some(&ch) = self.src.get(self.pos) {
                    if ch.is_ascii_alphanumeric() || ch == '$' {
                        self.pos += 1;
                    } else {
                        break;
                    }
                }
                let word2: String = self.src[start2..self.pos].iter().collect();
                let Some(end) = Addr::parse(&word2) else {
                    return Err("#REF!".into());
                };
                return Ok(Node::Range(addr, end));
            }
            return Ok(Node::Ref(addr));
        }

        Err("#PARSE!".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sheet(pairs: &[(&str, &str)]) -> Sheet {
        let mut s = Sheet::default();
        for (addr, raw) in pairs {
            s.set(addr, raw);
        }
        s
    }

    fn val(s: &Sheet, addr: &str) -> String {
        s.eval_cell(Addr::parse(addr).unwrap()).display()
    }

    #[test]
    fn a1_addresses_round_trip() {
        for a1 in ["A1", "Z1", "AA1", "AB10", "ZZ100", "AAA1"] {
            assert_eq!(Addr::parse(a1).unwrap().to_a1(), a1);
        }
    }

    #[test]
    fn arithmetic_precedence_is_respected() {
        let s = sheet(&[("A1", "=2+3*4"), ("A2", "=(2+3)*4"), ("A3", "=2^3^2")]);
        assert_eq!(val(&s, "A1"), "14");
        assert_eq!(val(&s, "A2"), "20");
        assert_eq!(val(&s, "A3"), "512"); // right-associative
    }

    #[test]
    fn sums_a_range() {
        let s = sheet(&[
            ("A1", "1"), ("A2", "2"), ("A3", "3"), ("A4", "4"),
            ("B1", "=SUM(A1:A4)"), ("B2", "=AVERAGE(A1:A4)"), ("B3", "=COUNT(A1:A4)"),
        ]);
        assert_eq!(val(&s, "B1"), "10");
        assert_eq!(val(&s, "B2"), "2.5");
        assert_eq!(val(&s, "B3"), "4");
    }

    #[test]
    fn chains_references_through_cells() {
        let s = sheet(&[("A1", "10"), ("A2", "=A1*2"), ("A3", "=A2+A1")]);
        assert_eq!(val(&s, "A3"), "30");
    }

    #[test]
    fn division_by_zero_is_an_error_value() {
        let s = sheet(&[("A1", "=1/0"), ("A2", "=A1+1")]);
        assert_eq!(val(&s, "A1"), "#DIV/0!");
        assert_eq!(val(&s, "A2"), "#DIV/0!", "errors must propagate");
    }

    /// A cycle must terminate with an error rather than hang the app.
    #[test]
    fn direct_cycle_is_detected() {
        let s = sheet(&[("A1", "=A2"), ("A2", "=A1")]);
        assert_eq!(val(&s, "A1"), "#CYCLE!");
    }

    #[test]
    fn indirect_cycle_is_detected() {
        let s = sheet(&[("A1", "=B1"), ("B1", "=C1"), ("C1", "=A1")]);
        assert_eq!(val(&s, "A1"), "#CYCLE!");
    }

    #[test]
    fn self_reference_in_a_range_is_detected() {
        let s = sheet(&[("A1", "1"), ("A2", "=SUM(A1:A3)"), ("A3", "2")]);
        assert_eq!(val(&s, "A2"), "#CYCLE!");
    }

    #[test]
    fn if_does_not_evaluate_the_untaken_branch() {
        let s = sheet(&[("A1", "0"), ("B1", "=IF(A1=0,\"safe\",1/0)")]);
        assert_eq!(val(&s, "B1"), "safe");
    }

    #[test]
    fn comparisons_and_text() {
        let s = sheet(&[
            ("A1", "5"),
            ("B1", "=A1>3"),
            ("C1", "=\"a\"&\"b\""),
            ("D1", "=UPPER(\"odyssey\")"),
            ("E1", "=LEN(\"abcd\")"),
        ]);
        assert_eq!(val(&s, "B1"), "TRUE");
        assert_eq!(val(&s, "C1"), "ab");
        assert_eq!(val(&s, "D1"), "ODYSSEY");
        assert_eq!(val(&s, "E1"), "4");
    }

    #[test]
    fn unknown_function_names_report_cleanly() {
        let s = sheet(&[("A1", "=VLOOKUP(1,2,3)")]);
        assert_eq!(val(&s, "A1"), "#NAME?");
    }

    #[test]
    fn malformed_formulas_do_not_panic() {
        for bad in ["=1+", "=(1", "=)", "=SUM(", "=\"unterminated", "=A1:", "=*"] {
            let s = sheet(&[("A1", bad)]);
            assert!(val(&s, "A1").starts_with('#'), "{bad} should error");
        }
    }

    /// Regression test for §8.4: deep nesting must not exhaust the stack.
    #[test]
    fn deeply_nested_formula_is_bounded() {
        let deep = format!("={}1{}", "(".repeat(300), ")".repeat(300));
        let s = sheet(&[("A1", deep.as_str())]);
        assert!(val(&s, "A1").starts_with('#'));
    }

    #[test]
    fn text_cells_stay_text() {
        let s = sheet(&[("A1", "hello"), ("A2", "=A1")]);
        assert_eq!(val(&s, "A2"), "hello");
    }

    #[test]
    fn evaluate_all_covers_every_populated_cell() {
        let s = sheet(&[("A1", "2"), ("A2", "=A1*3")]);
        let all = s.evaluate_all();
        assert_eq!(all.get("A2").unwrap().display(), "6");
        assert_eq!(all.len(), 2);
    }
}
