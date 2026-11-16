/**
 * The causal sources hard group's second unsupported link, one per corpus, by a general rule.
 *
 * Every corpus's unsupported link reaches a stock through one of its flows (sign-ups into members,
 * volunteers leaving out of volunteers, breakdowns taking vans out of service). The second
 * unsupported link is that stock's other flow: its outflow when the corpus's link is the stock's
 * inflow (polarity +), its inflow when the corpus's link drains it (polarity -). The flow joins the
 * hard prompt's glossary under a plain name; no document mentions it (`notStated`, checked against
 * every document by the unit tests), so the diagram needs the link and only an assumption can
 * support it. Nothing here is chosen by how any agent did.
 *
 * @module categories/causalSourcesData/hardLinks
 */

export const HARD_SECOND = {
    bikeShare: { flow: 'members leaving', notStated: 'cancel|quit|lapse|drop(ped|s)? out|members? (leav|left)|(leave|left) the scheme' },
    ambulanceService: { flow: 'crews returning from sick leave', notStated: 'return|back (to work|on shift|from)|came back|recover' },
    coffeeCoop: { flow: 'farms leaving', notStated: 'leav|left the|quit|withdr|drop(ped|s)? out|pull(ed|s)? out' },
    foodBankVolunteers: { flow: 'new volunteers', notStated: 'recruit|new volunteer|join|sign(ed|s|ing)? (up|on)|took on|taken on' },
    kitchenBacklog: { flow: 'jobs completed', notStated: 'complet|fitted|finish(ed|es)? (a |the |each |every )?(job|kitchen)|jobs? (done|finished)|clear(s|ed|ing)? the (backlog|list|queue)' },
    mushroomGrowers: { flow: 'growers giving up', notStated: 'give up|gave up|giving up|quit|\\bclos(e|ed|es|ing)\\b|leav|left the|stop(ped|s)? growing|exit' },
    parcelVans: { flow: 'repaired vans', notStated: 'repair|fixed|back on the road|back in service|return(ed|s)? to service' }
};

/**
 * The second unsupported link of a corpus, by the rule: the other flow of the stock its unsupported
 * link reaches.
 * @param {Object} c A corpus spec
 * @returns {{from: string, to: string, polarity: string}}
 */
export const secondUnsupported = function(c) {
    const { flow } = HARD_SECOND[c.id];
    return { from: flow, to: c.unsupported.to, polarity: c.unsupported.polarity === '+' ? '-' : '+' };
};
