import { ConfigValueError, defineConfigSection } from "../config/config_file.ts";

export type NetworkSettings = { address: string; port: number } | undefined;

const NETWORK_KEYS = ["address", "port"];
const MIN_PORT = 1;
const MAX_PORT = 65535;

type Table = Record<string, unknown>;

const isTable = (value: unknown): value is Table =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const readAddress = (table: Table): string => {
    const value = table.address;
    if (value === undefined) throw new ConfigValueError("address", "is required");
    if (typeof value !== "string" || value === "") {
        throw new ConfigValueError("address", "must be a non-empty IP address or host name");
    }
    return value;
};

const readPort = (table: Table): number => {
    const value = table.port;
    if (value === undefined) throw new ConfigValueError("port", "is required");
    if (typeof value !== "number" || !Number.isInteger(value) || value < MIN_PORT || value > MAX_PORT) {
        throw new ConfigValueError("port", `must be an integer from ${MIN_PORT} to ${MAX_PORT}`);
    }
    return value;
};

/** The `[network]` section: its absence keeps the network listener off. */
export const networkSection = defineConfigSection<NetworkSettings>({
    name: "network",
    defaults: () => undefined,
    parse(table) {
        if (!isTable(table)) throw new ConfigValueError("network", "must be a table");
        const unknownKey = Object.keys(table).find((key) => !NETWORK_KEYS.includes(key));
        if (unknownKey !== undefined) throw new ConfigValueError(unknownKey, "is not a network setting");
        return { address: readAddress(table), port: readPort(table) };
    },
    serialize: (value) => (value === undefined ? {} : { address: value.address, port: value.port }),
});
