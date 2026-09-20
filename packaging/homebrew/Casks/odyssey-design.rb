cask "odyssey-design" do
  version "0.1.0"

  # Two architectures, two disk images, two checksums.
  on_arm do
    sha256 "f1f4aed05b340b87f87b652d09c91bb1c64ff171f2b745cba1db5e3fb3db3ee2"
    url "https://github.com/Fs1lyric/odyssey-design/releases/download/v#{version}/OdysseyDesign_#{version}_macOS_arm64.dmg"
  end
  on_intel do
    sha256 "fc1208e91b55e0712f08386aded95a33f135915d1461c080e6cca74b03cfc263"
    url "https://github.com/Fs1lyric/odyssey-design/releases/download/v#{version}/OdysseyDesign_#{version}_macOS_x64.dmg"
  end

  name "Odyssey Design"
  desc "Local-first editor for documents, spreadsheets, decks and video"
  homepage "https://github.com/Fs1lyric/odyssey-design"

  livecheck do
    url :url
    strategy :github_latest
  end

  # The video editor invokes ffmpeg and ffprobe by name, so it needs them on
  # PATH. This is a recommendation rather than a hard dependency: the document,
  # spreadsheet and deck editors work without them.
  depends_on formula: "ffmpeg"
  depends_on macos: ">= :monterey"

  app "odyssey-design.app"

  zap trash: [
    "~/Library/Application Support/com.lyric.odyssey-design",
    "~/Library/Caches/com.lyric.odyssey-design",
    "~/Library/Saved Application State/com.lyric.odyssey-design.savedState",
  ]

  caveats <<~EOS
    Odyssey Design is not notarized. macOS will refuse to open it until you
    allow it in System Settings, under Privacy and Security.

    Your documents are stored in:
      ~/Library/Application Support/com.lyric.odyssey-design
  EOS
end
