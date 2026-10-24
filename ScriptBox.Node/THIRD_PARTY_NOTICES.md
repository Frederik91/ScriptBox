# Third-party notices

`@frederik91/scriptbox` bundles one compiled file built from third-party
source: `dist/assets/scriptbox-async.wasm`. Its inputs are pinned in
`ScriptBox.Wasm/toolchain.env` in the ScriptBox repository.

## QuickJS

Source: https://github.com/bellard/quickjs, commit
fcbf5ea2a63510f35f9ab2baadd59781be16a167. Compiled into
`scriptbox-async.wasm`.

```
QuickJS Javascript Engine

Copyright (c) 2017-2021 Fabrice Bellard
Copyright (c) 2017-2021 Charlie Gordon

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## WASI SDK 28.0: wasi-libc and compiler-rt

`scriptbox-async.wasm` is linked against the C library and compiler runtime
of WASI SDK 28.0 (https://github.com/WebAssembly/wasi-sdk).

- wasi-libc is licensed under Apache-2.0 WITH LLVM-exception OR Apache-2.0
  OR MIT, and includes code from musl libc (MIT, Copyright © 2005-2020 Rich
  Felker, et al.) and other sources listed in its licence file:
  https://github.com/WebAssembly/wasi-libc/blob/main/LICENSE
- compiler-rt is part of LLVM and licensed under Apache-2.0 WITH
  LLVM-exception: https://github.com/llvm/llvm-project/blob/main/LICENSE.TXT

## Runtime dependencies

These are installed from the npm registry next to this package, not bundled
in it. Each carries its own licence.

| Package | Version | Licence |
| --- | --- | --- |
| typebox | 1.4.3 | MIT |
| typescript | 6.0.3 | Apache-2.0 |
