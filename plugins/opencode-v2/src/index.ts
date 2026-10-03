import { Plugin } from "@opencode/plugin";
import { createSensor, type SensorOptions } from "./sensor.js";

const SensorPlugin = Plugin.define({
  id: "opencode-sensor-v2",
  async setup(ctx) {
    const sensor = await createSensor(ctx, ctx.options as SensorOptions);
    return sensor.dispose;
  },
});

export default SensorPlugin;
