/**
 * The example paragraph shown on first visit and by the Example button.
 *
 * Every mistake in it is one Harper 3.0.0 flags in all five dialects, and accepting each top
 * suggestion leaves a correct paragraph with nothing else flagged (see test/sample.test.ts).
 * Change it only together with that test.
 */
export const SAMPLE = `Welcome to GrammarMe. Its a free writing assistant that runs on your device.

Their are a few mistakes in this paragraph. I recieve a email every week, and this sentense needs fixing. Click an underlined word to see the fix, or press Clear to type your own text.`;

/** What SAMPLE becomes after accepting every top suggestion. */
export const SAMPLE_FIXED = `Welcome to GrammarMe. It's a free writing assistant that runs on your device.

There are a few mistakes in this paragraph. I receive an email every week, and this sentence needs fixing. Click an underlined word to see the fix, or press Clear to type your own text.`;
