# Environment setup

Run this before installing anything:

```bash
node scripts/preflight.mjs
```

It checks the Node and npm versions, free space on the volumes that matter, git identity, the Docker
daemon and the ports the stack uses. Every failure prints the command that fixes it. The rest of this
page explains the cases the preflight can only report, not repair.

## Disk space

The npm cache, Playwright's browser downloads, Foundry's toolchain and Docker's virtual disk are all
large and all default to the system drive. A monorepo of this size plus Chromium plus a Postgres
image needs roughly **8-10 GB**, and Docker's disk grows well past that over time.

If the preflight reports low space on the npm cache volume, point the cache somewhere with room. A
`.npmrc` at the repository root is gitignored precisely so machine-specific paths can live there:

```ini
cache=D:/dev-cache/npm-cache
fund=false
```

Then remove `node_modules` and reinstall so nothing is left behind on the full volume.

Playwright and Foundry read environment variables rather than npm config:

```bash
# Windows (PowerShell, current user)
setx PLAYWRIGHT_BROWSERS_PATH "D:\dev-cache\ms-playwright"
setx FOUNDRY_DIR "D:\dev-cache\foundry"

# macOS / Linux
export PLAYWRIGHT_BROWSERS_PATH="$HOME/.cache/ms-playwright"
export FOUNDRY_DIR="$HOME/.foundry"
```

### Moving Docker Desktop's disk on Windows

Docker Desktop's WSL2 data disk (`docker_data.vhdx`) is allocated eagerly and does not shrink when
images are deleted. It regularly reaches 100 GB or more on the system drive.

The supported route is **Docker Desktop → Settings → Resources → Advanced → Disk image location**,
which copies the disk and updates the configuration in one step. To do it by hand instead:

1. Quit Docker Desktop completely and confirm no `docker` processes remain.
2. Run `wsl --shutdown`.
3. Move `%LOCALAPPDATA%\Docker\wsl\disk\docker_data.vhdx` to the target volume, preserving the
   `wsl\disk` directory structure.
4. In `%APPDATA%\Docker\settings-store.json`, point `CustomWslDistroDir` at the new `wsl` directory
   and `DataFolder` at the new data directory.
5. Start Docker Desktop and confirm `docker info` reports a server version.

The disk holds every image, container and named volume, so moving it preserves them. Deleting it
instead is equivalent to a factory reset of Docker.

## Windows specifics

- **Defender.** Exclude the repository's `node_modules` and `.next` directories from real-time
  scanning. Turbopack keeps an on-disk cache and Defender scanning it is the most common cause of
  slow rebuilds.
- **Line endings.** `.gitattributes` sets `eol=lf` for everything. Do not override it with
  `core.autocrlf=true`; git hooks and container entrypoints fail with `\r: not found` under CRLF.
- **Shell.** npm scripts stay single-command. PowerShell 5.1 has no `&&` chaining and no inline
  `VAR=value command` prefix, so neither appears in `package.json`.

## Docker

Docker is required for `docker compose up` and for the Postgres that integration tests use. It is
**not** required for unit tests or for the local Anvil chain, which runs as a native binary. The
preflight reports a missing daemon as a warning rather than a failure for exactly that reason.
