#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";

registerHooks({
	load(url, context, nextLoad) {
		if (!url.endsWith(".ts")) return nextLoad(url, context);
		return { format: "module", source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8")), shortCircuit: true };
	}
});
await import("../src/cli.ts");
