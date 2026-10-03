import type { Plugin } from "@opencode-ai/plugin";
import { createSensor, type SensorOptions } from "./sensor.js";

// Export a single plugin entry: OpenCode V1 loads each exported plugin function.
const SensorPlugin: Plugin = async (input, options) =>
  createSensor(input, options as SensorOptions);

export default SensorPlugin;
