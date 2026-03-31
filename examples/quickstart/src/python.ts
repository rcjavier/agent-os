// Run a Python script inside the VM that does filesystem operations.

import { AgentOs } from "@rivet-dev/agent-os-core";
import common from "@rivet-dev/agent-os-common";

const vm = await AgentOs.create({ software: [common] });

await vm.writeFile(
	"/tmp/demo.py",
	`
import os
import json

# Create a directory and write files
os.makedirs("/project/src", exist_ok=True)

with open("/project/src/main.py", "w") as f:
    f.write("print('hello')")

with open("/project/README.md", "w") as f:
    f.write("# My Project")

# Read them back
files = os.listdir("/project")
print("Files:", files)

with open("/project/src/main.py") as f:
    print("main.py:", f.read())

stat = os.stat("/project/README.md")
print("README size:", stat.st_size, "bytes")
`,
);

const result = await vm.exec("python /tmp/demo.py");
console.log(result.stdout);
console.log("Exit code:", result.exitCode);

await vm.dispose();
