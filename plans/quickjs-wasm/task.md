this repo contains edgejs, a node.js alternative, driven through napi bindings, and wasmer / webassembly integration. 

the current setup mainly targets using v8 as the engine, compiling edgejs itself to webassembly, and then using host napi bindings through WASM imports. 

We want an alternative way to run edgejs in webassembly with the quickjs JS engine, but with quickjs compiled directly to webassembly instead of going through the napi host bridge. 

do some research, and come up with a plan how to implement this.
notes: 

it might make sense to look for existing