// Provider-Flag und JSON-Only-Pflicht – Single Source of Truth für alle Submodule.
// Für lokale Provider (ollama, llama) werden Prompts abgespeckt:
// - JSON_ONLY entfällt, weil lib/ai.js Grammar-Constrained JSON-Output erzwingt (format: 'json' / response_format).
// - commonRules wird durch eine kompakte Slim-Version ersetzt (siehe core.js).
// - Lektorat-Prompts droppen Beispiele, WICHTIG-Paragrafen und spezialisierte Fehler-Typen.
// - Komplett-Extraktions-Schema droppt lange Regeln (Schema bleibt, einzeilige Regeln statt Paragrafen).

export let _isLocal = false;

export function _setIsLocal(v) { _isLocal = !!v; }

// Unveränderliche technische Pflicht-Anweisung – darf nicht konfiguriert werden,
// da callAI() immer ein JSON-Objekt erwartet.
export const JSON_ONLY = 'Antworte ausschliesslich mit einem JSON-Objekt – kein Markdown, kein Text davor oder danach. Beginne deine Antwort direkt mit { und beende sie mit }.\n\nJSON-QUOTE-SICHERHEIT (zwingend): Innerhalb von String-Werten dürfen literale gerade Anführungszeichen (ASCII U+0022) NUR als JSON-String-Begrenzer vorkommen, NIEMALS innerhalb des Inhalts. Wenn du im Inhalt eines Feldes (insbesondere «erklaerung», «kommentar», «fazit», «stilanalyse») über Anführungszeichen sprechen musst, verwende ausschliesslich typografische Unicode-Zeichen: Guillemets «» (U+00AB/U+00BB), deutsche „" (U+201E/U+201C), englische "" (U+201C/U+201D). Beispiel falsch: "erklaerung": "nicht als gerade Anführungszeichen (")". Beispiel richtig: "erklaerung": "nicht als gerade Anführungszeichen («»)". Verstoss zerstört das JSON.';

export function _jsonOnly() { return _isLocal ? '' : `\n\n${JSON_ONLY}`; }
