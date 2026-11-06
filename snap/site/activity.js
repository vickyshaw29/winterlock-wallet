// Live transaction feedback next to the action that created it. The caller supplies only observed status and steps.
// No wallet, signing, storage, or network access.

/**
 * @typedef {{ state: string, heading: string, leaf: number, lane: string, steps: string[], note?: string, inspect?: () => void, href?: string }} Activity
 */

/** @param {HTMLElement} target @param {Activity | null} activity */
export function drawActivity(target, activity) {
  if (!activity) { target.hidden = true; delete target.dataset.drawing; target.replaceChildren(); return; }
  const signature = JSON.stringify([activity.state, activity.heading, activity.leaf, activity.lane, activity.steps, activity.note, activity.href]);
  if (target.dataset.drawing === signature) return;
  target.dataset.drawing = signature;
  target.hidden = false;
  target.dataset.state = activity.state;
  const node = (/** @type {string} */ tag, /** @type {string} */ cls, /** @type {string} */ text) => {
    const e = document.createElement(tag); e.className = cls; e.textContent = text; return e;
  };
  const head = node("div", "activity-head", "");
  head.append(node("span", "activity-signal", ""), node("strong", "activity-title", activity.heading));
  const facts = node("p", "activity-facts", `Leaf ${activity.leaf} on lane ${activity.lane}`);
  const steps = node("ol", "activity-steps", "");
  steps.setAttribute("aria-label", "Observed transaction progress");
  for (const [i, step] of activity.steps.entries()) steps.append(node("li", i === activity.steps.length - 1 ? "current" : "complete", step));
  const parts = [head, facts, steps];
  if (activity.note) parts.push(node("p", "activity-note", activity.note));
  if (activity.inspect) {
    const button = document.createElement("button"); button.type = "button"; button.className = "activity-inspect";
    button.textContent = "Inspect lane"; button.addEventListener("click", activity.inspect); parts.push(button);
  } else if (activity.href) {
    const link = document.createElement("a"); link.className = "activity-inspect"; link.textContent = "View in explorer";
    link.href = activity.href; link.target = "_blank"; link.rel = "noopener noreferrer"; parts.push(link);
  }
  target.replaceChildren(...parts);
}
