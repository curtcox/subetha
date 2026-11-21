# subetha

Messaging platform: send and receive ntfy-style messages between any devices over any
transport (IP, push, email, Slack, SMS/voice, MCP, Reticulum, Bluetooth, audio, QR/video),
without devices needing to know about each other or how messages are relayed.

Production: https://subetha.org

See [PLAN.md](PLAN.md) for the project plan and open questions.

## File size limits

Pushes are checked so large files don't end up in the repository's history.
Every file added or changed by the commits being pushed must be under a
limit based on its type:

| Type | Examples | Limit |
| --- | --- | --- |
| SVG | `.svg` | 200 KB |
| Source / text / config | `.py` `.js` `.md` `.yml` `Makefile` … | 500 KB |
| Images | `.png` `.jpg` `.gif` `.webp` … | 1 MB |
| Fonts | `.woff2` `.ttf` `.otf` … | 1 MB |
| Data | `.csv` `.json` `.xml` `.sql` … | 2 MB |
| Lockfiles | `package-lock.json` `yarn.lock` `Cargo.lock` … | 2 MB |
| Documents | `.pdf` `.docx` `.pptx` `.xlsx` … | 5 MB |
| Archives / binaries | `.zip` `.tar.gz` `.jar` `.exe` `.so` `.wasm` … | 5 MB |
| Audio / video | `.mp3` `.wav` `.mp4` `.mov` `.webm` … | 10 MB |
| Anything else | | 1 MB |

Run `scripts/check-file-sizes.sh --list-defaults` for the full list.

The check runs in two places:

- **Locally, before each push.** Enable the hook once per clone:

  ```bash
  git config core.hooksPath .githooks
  ```

- **In CI** (`.github/workflows/file-size-check.yml`), on every push and pull
  request, so files pushed without the hook (or with `--no-verify`) are
  caught too.

To commit a file that legitimately exceeds its limit, add an entry to
[`.filesize-allow`](.filesize-allow) (for example `assets/hero.png 3MB`) and
commit it. Only the committed allowlist counts, so exceptions get reviewed.

You can also run the check by hand:

```bash
scripts/check-file-sizes.sh --range origin/main..HEAD   # commits not yet on main
scripts/check-file-sizes.sh --tree                      # every file at HEAD
```
