import { enterFixtureProcessWork, runFixtureProcessMaintenance } from "../scripts/fixture-process-maintenance.mjs";

const [mode, root] = process.argv.slice(2);
const idle = {
  atomicSnapshot: true, idleConfirmed: true, activeMcpRequests: 0,
  backgroundReconciliationActive: false, jobInspectionAvailable: true,
  browserInspectionAvailable: true, managedBrowser: false,
  managedProcesses: [], durableJobs: [],
};

function awaitParentRelease() {
  return new Promise(resolve => {
    process.stdin.once("data", () => { process.stdin.destroy(); resolve(); });
    process.stdin.resume();
  });
}

try {
  if (mode === "work") {
    const release = await enterFixtureProcessWork(root);
    process.stdout.write("WORK_ADMITTED\n");
    await awaitParentRelease();
    await release();
  } else if (mode === "maintain") {
    await runFixtureProcessMaintenance(root, async () => idle, async () => {
      process.stdout.write("MAINTENANCE_HELD\n");
      await awaitParentRelease();
    });
  } else {
    throw Error("Invalid fixture child operation");
  }
  process.stdout.write("RELEASED\n");
} catch (error) {
  process.stderr.write("DENIED: " + error.message + "\n");
  process.exitCode = 2;
}
