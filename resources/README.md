# resources/

CI downloads the matching `cloudflared` binary here before packaging the
server app; electron-builder copies it into the app bundle. Binaries are
gitignored.
