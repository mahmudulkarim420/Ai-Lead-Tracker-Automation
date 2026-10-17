import { analyzeLead } from "./src/services/lead-analyzer.js";

const msg = "Test lead message for workflow validation";
console.log("Testing message:", msg);

try {
  await analyzeLead(msg);
} catch (e) {
  console.log("Error type:", typeof e);
  console.log("Error constructor:", (e as any).constructor?.name);
  console.log("Error name:", (e as any).name);
  console.log("Error message:", (e as any).message);
  console.log("Error status:", (e as any).status);
  console.log("Error statusCode:", (e as any).statusCode);
  console.log("Error code:", (e as any).code);
  
  if ((e as any).cause) {
    const cause = (e as any).cause;
    console.log("--- CAUSE ---");
    console.log("Cause type:", typeof cause);
    console.log("Cause constructor:", cause.constructor?.name);
    console.log("Cause name:", cause.name);
    console.log("Cause message:", cause.message);
    console.log("Cause status:", cause.status);
    console.log("Cause statusCode:", cause.statusCode);
    console.log("Cause code:", cause.code);
    console.log("Cause keys:", Object.keys(cause));
  }
}
