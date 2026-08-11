import { describe, it, expect } from "vitest";
import { consolidateArpDevices } from "./poller.js";
import type { LnmsArpEntry } from "../librenms/types.js";

// Device IDs used across these tests. DOWN_ID is an enabled-but-down LibreNMS
// device whose ARP cache is stale; UP_ID devices are polling normally.
const DOWN_ID = 40;
const UP_ID = 51;
const UP_ID_2 = 5;

const TARGET_MAC = "48B02D5E2ECC";
const TARGET_IP = "192.168.5.235";

function arpEntry(deviceId: number, overrides: Partial<LnmsArpEntry> = {}): LnmsArpEntry {
  return {
    id: deviceId * 1000,
    port_id: deviceId * 10,
    device_id: deviceId,
    mac_address: TARGET_MAC,
    ipv4_address: TARGET_IP,
    context_name: "",
    ...overrides,
  };
}

function run(entries: LnmsArpEntry[], downIds: number[] = [DOWN_ID]) {
  const deviceIdToHostname = new Map<number, string>([
    [DOWN_ID, "172.29.0.12"],
    [UP_ID, "192.168.5.2"],
    [UP_ID_2, "192.168.5.1"],
  ]);
  const hostnameToLocation = new Map<string, string>([
    ["172.29.0.12", "DXB"],
    ["192.168.5.2", "DXB"],
    ["192.168.5.1", "DXB"],
  ]);
  return consolidateArpDevices(
    entries,
    new Map(),                                    // managedIpsByLocation
    new Map(),                                    // managedMacsByLocation
    deviceIdToHostname,
    hostnameToLocation,
    () => false,                                  // isOverlayIp
    new Map<number, string>([                     // portIdToIfName
      [DOWN_ID * 10, "eth0"],
      [UP_ID * 10, "br-lan"],
      [UP_ID_2 * 10, "igb0"],
    ]),
    new Map(),                                    // portIdToMac
    new Map(),                                    // portIdToIp
    new Set([DOWN_ID, UP_ID, UP_ID_2]),           // activeDeviceIds
    new Set(downIds),                             // downDeviceIds
  );
}

describe("consolidateArpDevices sourceDown", () => {
  it("does not flag sourceDown when a down source is listed before an up source for the same MAC+IP", () => {
    const devices = run([arpEntry(DOWN_ID), arpEntry(UP_ID)]);

    expect(devices).toHaveLength(1);
    expect(devices[0].sourceDown).toBe(false);
  });

  it("attributes seenByHostname to an up source rather than the first-listed down source", () => {
    const devices = run([arpEntry(DOWN_ID), arpEntry(UP_ID)]);

    expect(devices[0].seenByHostname).toBe("192.168.5.2");
    expect(devices[0].seenByInterface).toBe("br-lan");
  });

  it("still flags sourceDown when every contributing source is down", () => {
    const devices = run([arpEntry(DOWN_ID), arpEntry(UP_ID)], [DOWN_ID, UP_ID]);

    expect(devices).toHaveLength(1);
    expect(devices[0].sourceDown).toBe(true);
  });

  it("keeps a single up source unflagged", () => {
    const devices = run([arpEntry(UP_ID)]);

    expect(devices[0].sourceDown).toBe(false);
    expect(devices[0].seenByHostname).toBe("192.168.5.2");
  });
});
