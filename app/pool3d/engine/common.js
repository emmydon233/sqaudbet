/** Shared constants/types for the Pool gameplay HUD/audio. Pool-only: nothing here is used by other pages. */
/** Ball colours used by the HUD chips (match the cinematic table's ball colours). */
export const BALL_COLORS = {
    1: 0xf6cc4f, 2: 0x2868c7, 3: 0xc83d35, 4: 0x743eaa, 5: 0xf07a2f, 6: 0x2f9a57, 7: 0x8c2638, 8: 0x111114,
    9: 0xf6cc4f, 10: 0x2868c7, 11: 0xc83d35, 12: 0x743eaa, 13: 0xf07a2f, 14: 0x2f9a57, 15: 0x8c2638,
};
export const cssColor = (hex) => `#${hex.toString(16).padStart(6, "0")}`;
export function groupLabel(group) {
    return group === "solid" ? "Solids" : group === "stripe" ? "Stripes" : "Open table";
}
export function safeStorage() {
    try {
        return window.localStorage;
    }
    catch {
        return null;
    }
}
