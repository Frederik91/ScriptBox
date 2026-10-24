# ScriptBox guest

The guest is QuickJS compiled to WebAssembly, with a small C bridge in `scriptbox_wrapper.c`. It builds one artifact, `scriptbox-async.wasm`, which the .NET host (`ScriptBox`) and the Node host (`ScriptBox.Node`) both run.

It speaks guest ABI 2. A host call is posted: `host.post` returns a call id, the script waits on a promise, and the host later calls `sb_resume` with the answer. Memory is imported (`env.memory`), so the host sets its maximum, and the allocator traps through `host.limit` when it is reached. The guest exports `sb_abi_version`, and each host checks it before a script runs. Both hosts load the same bootstrap, `scripts/sdk/scriptbox.js`.

ScriptBox 3's synchronous guest, `scriptbox.wasm` (ABI 1), is gone.

## Building

```sh
bash ScriptBox.Wasm/docker-build.sh
```

This needs only Docker with Linux containers. The image pins Debian, WASI SDK 28 (checked by SHA-256) and the QuickJS commit in `toolchain.env`. The compile step runs with the network off. It writes the artifact and `artifacts.json`, which records the inputs and the artifact's SHA-256.

The build is reproducible. CI runs it and fails if the artifact or `artifacts.json` differ from what is committed. The Node package checks the artifact's digest against `artifacts.json` when it builds and again when it loads.

To build without Docker, run `build.sh` with `WASI_SDK_PATH` set to WASI SDK 28 and `QUICKJS_DIR` set to a QuickJS clone that holds the pinned commit. The result matches the committed digest only with the same toolchain.

## Changing the guest

1. Edit `scriptbox_wrapper.c`, or change a pin in `toolchain.env`.
2. Run `docker-build.sh` and commit the artifact with `artifacts.json`.
3. In `ScriptBox.Node`, run `npm run build` to regenerate `src/generated/build-info.ts`, and commit it.
4. If an export, an import or the meaning of a call changes, raise the ABI version in the wrapper and in both hosts.

`build.sh` makes two checked edits to `quickjs.c`. The script describes them.
