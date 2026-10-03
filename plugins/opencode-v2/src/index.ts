import { Plugin } from "@opencode/plugin";
import { withActionRejection } from "./runtime.js";
import { createSensor } from "./sensor.js";

const SensorPlugin = Plugin.define({
  id: "opencode-sensor-v2",
  async setup(ctx) {
    const sensor = await createSensor(ctx, ctx.options);
    return sensor.dispose;
  },
});

export default withActionRejection(SensorPlugin);
