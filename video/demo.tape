# Cipher Pol — Demo Recording
# No live devnet required. Transactions are simulated; ZK proof and HTTP flow are real.
#
# Prerequisites:
#   vhs video/demo.tape

Output "video/demo-raw.mp4"

Set Width 1920
Set Height 1080
Set FontSize 16
Set FontFamily "JetBrains Mono"
Set Theme "Catppuccin Mocha"
Set Padding 40
Set MarginFill "#050508"
Set WindowBar Colorful

# Short pause at start before typing
Sleep 1s

# Show project context
Type "cd ~/Projects/cipher-pol"
Enter
Sleep 800ms

# Run demo (reads POOL_ADDR from video/pool_addr.txt automatically)
Type "node scripts/demo.mjs"
Enter

# Wait for demo to complete — proof generation ~5s + chain confirms + sleeps
# Total script runtime: ~35-40s
Sleep 50s
