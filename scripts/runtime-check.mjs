const supportedMinimum = [22, 23, 3];
const actual = process.versions.node.split(".").map(Number);

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

if (compareVersions(actual, supportedMinimum) < 0) {
  process.stderr.write(
    "creative-engine contracts require Node.js >=22.23.3; detected " + process.versions.node + ".\n",
  );
  process.exitCode = 1;
} else {
  process.stdout.write("Node.js " + process.versions.node + " meets the contract runtime floor (22.23.3).\n");
}
