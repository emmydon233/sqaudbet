/**
 * Naija Pidgin pop-up messages. One collection per occasion so copy can be edited without touching any logic.
 * Plain data only: no wallet, auth or game code lives here.
 */
export type NaijaPopupKind = "login" | "register" | "win" | "loss";

export const LOGIN_MESSAGES: readonly string[] = [
  "Omo, wetin carry you come here? 😂",
  "Omo, you sef dey find daily 2k bah? Oya, na best of luck!",
  "My guy, you don show face! 🔥",
  "Ah! Another champion don enter! 😎",
  "Oga mi, the arena don miss you! 🎱",
  "See who dey here! Make we see if hand still dey sharp 😏",
  "Welcome back o! Table don dey wait for you 🔥",
  "Haba! You still remember the way come? 😂",
];

export const REGISTER_MESSAGES: readonly string[] = [
  "Welcome o! Another SquadBet champion don land! 🎉",
  "Omo, you don finally join us! 😂",
  "You don enter the arena. Make we see wetin you sabi play! 🎱",
  "New face, new champion! SquadBet dey gbadun you 😎",
  "Oya clap for yourself, you don join the squad! 🔥",
  "Na so we dey start o! Welcome to the family 🙌",
];

export const WIN_MESSAGES: readonly string[] = [
  "Omo! You carry am go! 😂🏆",
  "Who dey teach you this thing? You too sabi!",
  "Na correct champion we get here! 🔥",
  "Oya collect your flowers, superstar! 💐",
  "Your opponent never recover from that one! 😂",
  "Ehen! Na you be the oga for here! 👑",
  "Clean work! Even the table dey clap for you 👏",
  "Omo, you do am like say na training! 🔥",
];

export const LOSS_MESSAGES: readonly string[] = [
  "Omo, today no be your day. Try again! 😂",
  "Your village people try small today o!",
  "No shaking! Even champions dey lose sometimes. 💪",
  "Abeg, who hold your cue hand? 😂",
  "You nearly get am! Next round go better.",
  "E don happen! Dust yourself, the next one na yours 🔥",
  "No vex o, na small wahala. Run am back! 🎱",
  "Omo, that one pain, but you go bounce back! 😅",
];

export const NAIJA_MESSAGES: Record<NaijaPopupKind, readonly string[]> = {
  login: LOGIN_MESSAGES,
  register: REGISTER_MESSAGES,
  win: WIN_MESSAGES,
  loss: LOSS_MESSAGES,
};

/** Random message from the right collection; avoids repeating `previous` when more than one message exists. */
export function pickNaijaMessage(kind: NaijaPopupKind, previous?: string | null, random: () => number = Math.random): string {
  const pool = NAIJA_MESSAGES[kind];
  const choices = pool.length > 1 && previous ? pool.filter((m) => m !== previous) : pool;
  return choices[Math.min(choices.length - 1, Math.floor(random() * choices.length))];
}
