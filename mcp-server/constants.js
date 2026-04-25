export const STATUS = {
  CHARGING:  "Charging",
  PLUGGED_IN: "Plugged In",
  STANDBY:   "Standby",
};

export const MQTT_CMD = {
  ONLINE_WANTED:  "Max-Current-Online-Wanted-",
  OFFLINE_WANTED: "Max-Current-Offline-Wanted-",
};

// JuicePassProxy v0.5.x publishes all topics under this prefix
export const HMD_PREFIX = "hmd";

// Fixed device name used by JuicePassProxy v0.5.x (not the charger's serial ID)
export const DEVICE_NAME = "JuiceBox";
