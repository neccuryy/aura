import Player from "winplayer-node";
import type { Update, Position } from "winplayer-node";

export function positionToSeconds(pos: Position | undefined | null): number {
	if (!pos || typeof pos.howMuch !== "number") return 0;
	const when = pos.when instanceof Date ? pos.when.getTime() : new Date(pos.when).getTime();
	if (!isFinite(when)) return pos.howMuch;
	return pos.howMuch + (Date.now() - when) / 1000;
}

export class MediaWatcher {
	private player: InstanceType<typeof Player> | null = null;
	// the native addon crashes when calls overlap — serialize every call
	// through a single promise chain so only one runs at a time
	private chain: Promise<unknown> = Promise.resolve();

	constructor(onSessionChange: () => void) {
		try {
			this.player = new Player(() => {
				// must not await anything here: this callback would hold a slot
				// in the chain while getUpdate() queues behind it — deadlock.
				// just poke the poller outside the chain instead
				setTimeout(onSessionChange, 0);
			}) as InstanceType<typeof Player>;
		} catch (_e) {
			this.player = null;
		}
	}

	private run<T>(fn: () => T | PromiseLike<T>): Promise<T> {
		const next = this.chain.then(fn);
		this.chain = next.then(
			() => undefined,
			() => undefined
		);
		return next;
	}

	get available(): boolean {
		return this.player !== null;
	}

	getUpdate(): Promise<Update | null> {
		return this.run(async () => {
			if (!this.player) return null;
			try {
				return await this.player.getUpdate();
			} catch (_e) {
				return null;
			}
		});
	}

	getPosition(): Promise<number> {
		return this.run(() => {
			if (!this.player) return 0;
			try {
				return positionToSeconds(this.player.GetPosition());
			} catch (_e) {
				return 0;
			}
		});
	}

	playPause(): void {
		void this.run(() => {
			try { this.player?.PlayPause(); } catch (_e) { /* ignore */ }
		});
	}

	next(): void {
		void this.run(() => {
			try { this.player?.Next(); } catch (_e) { /* ignore */ }
		});
	}

	previous(): void {
		void this.run(() => {
			try { this.player?.Previous(); } catch (_e) { /* ignore */ }
		});
	}

	seek(seconds: number): void {
		void this.run(() => {
			try { this.player?.SetPosition(seconds); } catch (_e) { /* ignore */ }
		});
	}
}
