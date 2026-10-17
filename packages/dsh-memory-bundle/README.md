# DSH Memory Plus bundle

Install the standalone versioned Release package:

```sh
dsh plugin --profile headless add https://github.com/QIANLING-0831/dsh-memory-plus/releases/download/v0.2.2/dsh-memory-bundle-0.2.2.tgz
```

Requires Node.js 24, compatible DSH and pnpm on PATH. Use `web` instead of `headless` for the Web profile. The Release tarball contains all seven plugin implementations; no clone or per-package installation is needed. The source workspace manifest still uses `workspace:` dependencies for development; install the Release asset above.

See the [repository README](https://github.com/QIANLING-0831/dsh-memory-plus#4-安装) for functionality, host compatibility and verification details.
