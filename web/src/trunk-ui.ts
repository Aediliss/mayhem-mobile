/**
 * FORK: Settings → TRUNKING PLANS. EDACS, MPT1327 and LTR do not say what frequency a channel number is; a plan says it,
 * one site per line, and Dispatch uses a plan only once the site's control channel turns up where the plan puts it.
 */
import { parsePlans, type LcnPlan } from './dsp/fleet/plugins.js';

const KEY = 'mm.trunk.plans';
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
export const PLAN_EXAMPLE = 'EDACS Site 21: 851.0125 851.5125 852.0125 852.5125';

export function loadPlanText(): string { try { return localStorage.getItem(KEY) ?? ''; } catch { return ''; } }
export function loadPlans(): LcnPlan[] { return parsePlans(loadPlanText()).plans; }

export function trunkSettingsHtml(): string {
  return `<section class="sset" id="sec-trunk"><div class="sset-h">TRUNKING PLANS</div>
    <div class="srow" data-keys="trunking plans edacs mpt1327 ltr lcn channel plan"><div class="srl"><b>EDACS / MPT1327 / LTR channel plans</b><small>These systems send channel numbers (LCNs), not frequencies. One site per line: the protocol, a name, a colon, then the site's frequencies in MHz in LCN order (LCN 1 first), as RadioReference lists them. Dispatch uses a plan once that site's control channel is heard where the plan puts it; until then calls show their LCN only.</small></div></div>
    <textarea id="tp-text" class="txin" rows="5" spellcheck="false" aria-label="Trunking channel plans" placeholder="${esc(PLAN_EXAMPLE)}" style="margin-top:6px;font-family:inherit">${esc(loadPlanText())}</textarea>
    <div class="row" style="margin-top:6px"><button id="tp-save" class="tog">SAVE</button><span id="tp-status" class="caption"></span></div>
  </section>`;
}

/** Wire the section; `send` passes the parsed plans to the DSP worker. */
export function bindTrunkSettings(root: ParentNode, send: (plans: LcnPlan[]) => void): void {
  const ta = root.querySelector<HTMLTextAreaElement>('#tp-text'), st = root.querySelector<HTMLElement>('#tp-status'), save = root.querySelector<HTMLButtonElement>('#tp-save');
  if (!ta || !st || !save) return;
  const show = () => { const { plans, errors } = parsePlans(ta.value); st.textContent = errors.length ? errors.join(' · ') : `${plans.length} site${plans.length === 1 ? '' : 's'}`; return { plans, errors }; };
  show();
  save.onclick = () => {
    const { plans } = show();
    try { localStorage.setItem(KEY, ta.value); } catch { /* private window */ }
    send(plans);
  };
}
