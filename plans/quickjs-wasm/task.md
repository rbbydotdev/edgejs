this repo contains edgejs, a node.js alternative, driven through napi bindings, and wasmer / webassembly integration. 

the current setup mainly targets using v8 as the engine, compiling edgejs itself to webassembly, and then using host napi bindings through WASM imports. 

We want an alternative way to run edgejs in webassembly with the quickjs JS engine, but with quickjs compiled directly to webassembly instead of going through the napi host bridge. 

do some research, and come up with a plan how to implement this.
notes: 
* it might make sense to look for existing forks of quickjs that can already compile to webassembly.
* use  `nix run github:wasix-org/wasinix#wasixcc` for  a working wasixcc compiler 
* the end goal is to build a `quickjs-wasm/wasmer.toml` package definition that contains a wasm binary for edgejs, that uses quickjs directly from wasm and can be used to run code

be token efficient in your research and internal reasoning

compe up with a high quality step by step plan for how to implement this, and write it to ./plan.md 
