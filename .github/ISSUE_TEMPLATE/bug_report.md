---
name: Bug report
about: Something behaves differently from how it should
labels: bug
---

**What happened**

**What you expected**

**Steps to reproduce**

**Source media**
Codec, resolution and frame rate, and whether it has an audio track. `ffprobe`
output is ideal. A surprising number of bugs turn out to be a property of the
file rather than the timeline.

**If a render failed**
Use "Show the ffmpeg command" in the editor and paste the invocation, plus the
error text.

**Versions**
- Odyssey Design:
- ffmpeg (`ffmpeg -version | head -1`):
- OS:
