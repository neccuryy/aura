const { titleMatch, normTitle, looseMatch } = require("./dist/main/cover.js");

const cases = [
	["Говорят чо (Say wha')", "Говорят чо", true],
	["Ауди", "Ауди [prod. by Sqweezey]", true],
	["broken love?", "broken love? (Speed Up)", true],
	["тот день", "тот день, когда я ушёл", false],
	["Говорят чо", "Говорят чо", true],
	["NANANANA", "NaNaNa", false],
	// ё/е: player reports ё, Genius stores е
	["гайд на ограбление пятёрочки", "гайд на ограбление пятерочки (GTRP)", true],
	// censored title vs uncensored Genius title
	["Х*ярю якобс монарх", "Хуярю якобс монарх (Drink Jacobs Monarch)", true],
	// masked fallback must not loosen unrelated titles
	["тот день", "тот день, когда я ушёл*", false],
];

for (const [a, b, want] of cases) {
	const got = titleMatch(a, b);
	console.log(
		(got === want ? "OK  " : "FAIL") +
		" titleMatch(" + JSON.stringify(a) + ", " + JSON.stringify(b) + ") = " + got +
		" (want " + want + ")  [" + normTitle(a) + " vs " + normTitle(b) + "]"
	);
}
console.log("artist:", looseMatch("Валентин Дядька (Valentin Dyadka)", "Валентин Дядька"));
