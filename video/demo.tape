# Cipher Pol — Demo Recording
# Run AFTER: node scripts/rpc-proxy.mjs & and devnet is live with contracts deployed
#
# Prerequisites:
#   1. ~/bin/starknet-devnet --host 127.0.0.1 --port 5050 --seed 42
#   2. node scripts/rpc-proxy.mjs &
#   3. node tests/onchain.test.mjs   (writes pool address to video/pool_addr.txt)
#   4. vhs video/demo.tape

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
