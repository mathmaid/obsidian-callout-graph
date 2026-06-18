import { CalloutIndex } from "../index/CalloutIndex";
import { CalloutGraphSettings } from "../types";

/** The slice of the plugin that the suggest UIs depend on (avoids a circular import). */
export interface SuggestHost {
	index: CalloutIndex;
	settings: CalloutGraphSettings;
	recordRecent(id: string): void;
	recencyScore(id: string): number;
}
