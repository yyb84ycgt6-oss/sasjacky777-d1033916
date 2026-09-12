/**
 * Where the guidance model's weights live, declared once.
 *
 * The app carries its own model. Not a download link, not a first-run fetch —
 * the file ships in `public/`, so a clone of this repo has everything needed to
 * answer a question about itself on a machine that has never been online. That
 * is the whole reason the size is a constant here and not a comment: the Model
 * Bay budget, the station probe, the install command and the panel all read the
 * same numbers, so none of them can describe a file that is not the one on disk.
 */
import { GUIDANCE_MODEL } from "@/lib/microai/models";

/** Served path of the weights, relative to the app root. */
export const GUIDE_WEIGHTS_PATH = "/models/bonsai-1.7b/bonsai-1.7b.gguf";

/** Served path of the Ollama Modelfile that builds the guide from those weights. */
export const GUIDE_MODELFILE_PATH = "/models/bonsai-1.7b/Modelfile";

/** What the registry says this model weighs. */
export const GUIDE_WEIGHTS_MB = GUIDANCE_MODEL.sizeMB;

/** The ollama model name the app asks for. */
export const GUIDE_MODEL_ID = GUIDANCE_MODEL.id;

/**
 * The one command that installs the shipped weights into Ollama.
 *
 * It reads from the repo, never from a registry, so it works on a machine with
 * no network at all — which is the only kind of install this system promises.
 */
export const GUIDE_INSTALL_COMMAND = `ollama create ${GUIDE_MODEL_ID} -f public/models/bonsai-1.7b/Modelfile`;

export interface WeightsPresence {
  present: boolean;
  /** One line a person can act on. */
  detail: string;
}

/**
 * Is the model actually here?
 *
 * A repo can be cloned without its LFS objects, in which case the path serves a
 * pointer file of a few hundred bytes rather than a quarter of a gigabyte of
 * weights. Reporting that as "installed" would be the one lie this panel must
 * never tell, so presence is judged by what the byte range says, not by a 200.
 */
export async function checkGuideWeights(
  fetchImpl: typeof fetch = fetch,
  path: string = GUIDE_WEIGHTS_PATH,
): Promise<WeightsPresence> {
  try {
    const res = await fetchImpl(path, { method: "HEAD" });
    if (!res.ok) {
      return { present: false, detail: `${path} → HTTP ${res.status}` };
    }
    const length = Number(res.headers.get("content-length") ?? 0);
    if (length > 0 && length < 1024 * 1024) {
      return {
        present: false,
        detail: `${path} is ${length} bytes — an LFS pointer, not the weights. Run: git lfs pull`,
      };
    }
    if (!length) {
      // Served, but the host did not say how big it is. Claiming a size here
      // would be inventing one; claiming absence would be wrong too.
      return { present: true, detail: `${path} served — size not reported` };
    }
    return { present: true, detail: `${path} — ${Math.round(length / (1024 * 1024))} MB on disk` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { present: false, detail: `${path} → ${message}` };
  }
}
