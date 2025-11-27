import { execFile, spawnSync } from "node:child_process";
import util from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileP = util.promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const desc = `
Causal Decoder is a transformer decoder-only model fine-tuned on Qwen2.5-1.5B, which is an open-source small LLM with only 1.5 billion parameters. The model was fine-tuned using PyTorch. It is not a chat model, so it only works properly when the input is of the form 'more x leads to more y' etc. This model is in the process of development.
`;


class Engine {
  static description() {
    return desc;
  }

  static supportedModes() {
    try {
      const pythonExe =
        process.env.PYTHON ||
        (process.platform === "win32" ? "python" : "python3");

      const check = spawnSync(
        pythonExe,
        ["-c", "import transformers, torch, accelerate"],
        { encoding: "utf8" }
      );


      if (check.error || check.status !== 0) {
        return [];
      }

      return ["cld"];
    } catch {
      return [];
    }
  }

  static additionalParameters() {
    return [];
  }

  normalizePrompt(candidate) {
    if (candidate && typeof candidate === "object") {
      return String(candidate.backgroundKnowledge ?? "").trim();
    }

    if (typeof candidate === "string") {
      const trimmed = candidate.trim();
      if (!trimmed) return "";

      try {
        const parsed = JSON.parse(trimmed);
        return String(parsed?.backgroundKnowledge ?? "").trim();
      } catch {
        return trimmed;
      }
    }
    
    return "";
  }

  async generate(prompt, currentModel, parameters) {
    const candidate = parameters;
    const effectivePrompt = this.normalizePrompt(candidate);

    if (!effectivePrompt) {
      return { err: "No prompt provided (no backgroundKnowledge or text found)" };
    }

    try {
      const pythonExe =
        process.env.PYTHON ||
        (process.platform === "win32" ? "python" : "python3");
      const scriptPath = path.resolve(__dirname, "inference.py");

      const { stdout, stderr } = await execFileP(
        pythonExe,
        [scriptPath, effectivePrompt],
        {
          maxBuffer: 20 * 1024 * 1024,
        }
      );

      if (stderr && stderr.length) {
        console.warn(
          "[causal-decoder] PY STDERR:",
          stderr.toString().slice(0, 500)
        );
      }

      const raw = stdout?.toString() ?? "";
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return {
          err: "Python did not return valid JSON",
          raw: raw.slice(0, 800),
        };
      }

      if (parsed && typeof parsed === "object") {
        return { model: parsed.model ?? parsed };
      }

      return {
        err: "Unexpected Python output format",
        raw: raw.slice(0, 800),
      };
    } catch (err) {
      return { err: err.message || String(err) };
    }
  }
}

export default Engine;
