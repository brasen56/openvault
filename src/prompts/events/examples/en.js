/**
 * English event extraction few-shot examples.
 * 7 examples following SFW → kink gradient.
 */

export const EXAMPLES = [
    {
        label: 'Discovery (EN/SFW)',
        input: `*Ranger Mireille crouches over the cold fire pit and presses her palm flat to the ash. Still warm. She sweeps her torch across the shelter — sleeping roll shoved aside, a pack left open, half-eaten rations scattered like someone left in a hurry.*
"Someone was here within the hour," she says, pulling a scrap of cloth from the entrance post. The color matches the expedition uniform.`,
        thinking: `Step 1: Mireille -> found -> warm ash + disturbed roll + cloth; hour-old
Step 2: Cross-ref -> no memories of shelter or route
Step 3: Progression -> new discovery; first expedition evidence
Step 4: Format -> importance = 3; not transient; physical evidence`,
        output: `{
  "events": [{
    "summary": "Ranger Mireille found a recently abandoned shelter with warm ash, scattered rations, and an expedition-colored cloth — evidence someone was present within the last hour",
    "importance": 3,
    "temporal_anchor": null,
    "is_transient": false,
    "characters_involved": ["Mireille"],
    "witnesses": ["Mireille"],
    "location": "Abandoned shelter",
    "is_secret": false,
    "emotional_impact": { "Mireille": "urgency" },
    "relationship_impact": {}
  }]
}`,
    },
    {
        label: 'Combat injury (EN/Moderate)',
        input: `The attacker came out of the alley fast — blade already drawn. Corin caught the first slash on his forearm and threw himself back against the wall. The second strike got him below the ribs.
*Petra yanked him by the collar and hauled him around the corner before the man could follow.*
"How deep?" she demanded, pressing her hand over the wound.
"Keep moving," Corin said. His voice was steady. His legs weren't.`,
        thinking: `Step 1: Attacker -> slashed -> Corin(forearm) + stabbed(below ribs); Petra -> pulled -> Corin; wound depth = unknown
Step 2: Cross-ref -> no memories of attacker or confrontation
Step 3: Progression -> new event; first Corin injury; new threat
Step 4: Format -> importance = 4; Petra -> protected Corin(lethal threat)`,
        output: `{
  "events": [{
    "summary": "An unidentified attacker stabbed Corin below the ribs and slashed his forearm in an alley ambush before Petra pulled him to safety; wound depth is unknown",
    "importance": 4,
    "temporal_anchor": null,
    "is_transient": false,
    "characters_involved": ["Corin", "Petra"],
    "witnesses": ["Corin", "Petra"],
    "location": "Alley",
    "is_secret": false,
    "emotional_impact": { "Corin": "pain", "Petra": "alarm" },
    "relationship_impact": { "Petra→Corin": "physically protected Corin under lethal threat" }
  }]
}`,
    },
    {
        label: 'First sexual contact (EN/Explicit)',
        input: `Sabine pushed him down by the chest and climbed over him, knees bracketing his hips. She pulled her hair tie loose without looking away.
"Tell me if you want me to stop," she said. Not a question.
She rocked forward slowly, taking him in inch by inch, watching his mouth fall open. His hands came up to her hips — not to stop her, just to hold on. She set the pace, low and deliberate, learning what made his breath catch.`,
        thinking: `Step 1: Sabine -> pushed -> Theo down + consent check; began penetration; Theo = responsive
Step 2: Cross-ref -> no sexual contact memories
Step 3: Progression -> new dynamic; first penetrative encounter; Sabine controls pace
Step 4: Format -> importance = 4; Sabine = dominant(initiator + pace)`,
        output: `{
  "events": [{
    "summary": "Sabine initiated penetrative sex with Theo for the first time, setting the pace from above and issuing an explicit consent check before proceeding",
    "importance": 4,
    "temporal_anchor": null,
    "is_transient": false,
    "characters_involved": ["Sabine", "Theo"],
    "witnesses": ["Sabine", "Theo"],
    "location": null,
    "is_secret": false,
    "emotional_impact": { "Sabine": "control", "Theo": "pleasure" },
    "relationship_impact": { "Sabine→Theo": "sexual relationship initiated with Sabine directing pace and position" }
  }]
}`,
    },
    {
        label: 'Restraint scene (EN/Kink)',
        input: `"Wrists." Inara held up the silk cord and waited.
*Rook extended both hands without hesitation. She looped and knotted in two passes — secure but not punishing — then tested the tension with a firm tug.*
"Word?" she asked.
"Copper."
She walked slowly around behind him, let her fingers trail up the back of his neck. He didn't turn his head. "Good. Kneel."
He went down. She felt the quality of his attention shift — the particular stillness that meant he was inside the scene now, fully.`,
        thinking: `Step 1: Inara -> bound -> Rook(wrists, silk cord); safeword = copper; kneel -> obeyed; Rook = in scene
Step 2: Cross-ref -> no restraint or D/s memories
Step 3: Progression -> new dynamic; first restraint + safeword + positional command
Step 4: Format -> importance = 4; is_secret = true`,
        output: `{
  "events": [{
    "summary": "Inara bound Rook's wrists with silk cord, confirmed safeword 'copper', and commanded him to kneel — establishing their first physical restraint scene",
    "importance": 4,
    "temporal_anchor": null,
    "is_transient": false,
    "characters_involved": ["Inara", "Rook"],
    "witnesses": ["Inara", "Rook"],
    "location": null,
    "is_secret": true,
    "emotional_impact": { "Inara": "control", "Rook": "submission" },
    "relationship_impact": { "Inara→Rook": "dominant/submissive dynamic established; safeword 'copper' on record" }
  }]
}`,
    },
    {
        label: 'Dedup - scene progression (EN/Edge)',
        input: `Inara crouched in front of him and tilted his chin up with two fingers. His eyes were glassy — not distress, that softer thing.
"Copper?" she asked quietly.
"Green," he said. Voice noticeably thicker than before.
She studied his face for a long moment, then stood and stepped back.

<established_memories>Inara bound Rook's wrists with silk cord, confirmed safeword 'copper', and commanded him to kneel — establishing their first physical restraint scene</established_memories>`,
        thinking: `Step 1: Inara -> welfare check; Rook -> green; voice = thicker; Inara -> assessed face
Step 2: Cross-ref -> existing: restraint + safeword + kneel; core action = same
Step 3: Progression -> same dynamic; voice thicker -> subspace shift; Inara pausing = calibration
Step 4: Format -> importance = 2; state change in established scene`,
        output: `{
  "events": [{
    "summary": "Inara checked Rook mid-scene; he confirmed green with a noticeably thicker voice indicating subspace deepening",
    "importance": 2,
    "temporal_anchor": null,
    "is_transient": false,
    "characters_involved": ["Inara", "Rook"],
    "witnesses": ["Inara", "Rook"],
    "location": null,
    "is_secret": false,
    "emotional_impact": { "Rook": "deepening submission" },
    "relationship_impact": {}
  }]
}`,
    },
    {
        label: 'Everyday choices — transient vs durable (EN/SFW)',
        input: `Vera stood in front of the closet for a full minute before pulling out the black heels. "These," she decided, and slipped them on.
Damien glanced up from his book. "The red ones would have worked too."
"The red ones pinch. I'm wearing these."
Downstairs, the café was half-empty. Vera ordered the salmon salad with extra lemon; Damien got his usual — black coffee, two sugars.
"So about the apartment," Damien said, setting his cup down. "I signed the lease. We have until the first to move everything."
Vera's fork stopped halfway to her mouth. "You signed without me?"`,
        thinking: `Step 1: Vera -> chose -> black heels(pinch-free); Vera -> ordered -> salmon salad; Damien -> usual coffee; Damien -> signed -> lease(solo)
Step 2: Cross-ref -> no memories of wardrobe, food, or apartment
Step 3: Progression -> three events; shoes + salad = transient(one-day); lease = durable(legal commitment)
Step 4: Format -> shoes = importance 2(transient); salad = importance 1(trivial transient = skip); lease = importance 4(durable)`,
        output: `{
  "events": [
    {
      "summary": "Vera chose to wear the black heels today instead of the red ones because the red shoes pinch",
      "importance": 2,
      "temporal_anchor": null,
      "is_transient": true,
      "characters_involved": ["Vera"],
      "witnesses": ["Vera", "Damien"],
      "location": null,
      "is_secret": false,
      "emotional_impact": {},
      "relationship_impact": {}
    },
    {
      "summary": "Damien signed the apartment lease without Vera, giving them until the first of the month to move everything",
      "importance": 4,
      "temporal_anchor": null,
      "is_transient": false,
      "characters_involved": ["Damien", "Vera"],
      "witnesses": ["Damien", "Vera"],
      "location": "Café",
      "is_secret": false,
      "emotional_impact": { "Vera": "shock" },
      "relationship_impact": { "Damien→Vera": "major unilateral decision — signed lease without consultation" }
    }
  ]
}`,
    },
    {
        label: 'Conversational commitment (EN/SFW)',
        input: `"I can't keep covering Tuesday shifts," Yolanda said, dropping into the chair across from Marcus. "It's been three months."
Marcus looked up from his laptop. "You're right. I'll talk to Chen this week — I'll get you off the rotation."
"I need that in writing. Last time you said 'this week' it took six weeks."
"Fair." He pulled out his phone. "Logging it right now. Tuesday rotation, removed. Done."
Yolanda watched him type. "Thank you."`,
        thinking: `Step 1: Yolanda -> raised -> Tuesday grievance(3 months); Marcus -> commit -> talk to Chen; Yolanda -> demanded -> documentation; Marcus -> logged -> calendar
Step 2: Cross-ref -> no memories of shift arrangement
Step 3: Progression -> two events; chair-drop + thanks = transient; logged commitment = durable
Step 4: Format -> chair-drop = importance 2(transient); commitment = importance 3(durable)`,
        output: `{
  "events": [
    {
      "summary": "Yolanda dropped into the chair across from Marcus and thanked him after he logged the Tuesday rotation change",
      "importance": 2,
      "temporal_anchor": null,
      "is_transient": true,
      "characters_involved": ["Yolanda", "Marcus"],
      "witnesses": ["Yolanda", "Marcus"],
      "location": null,
      "is_secret": false,
      "emotional_impact": {},
      "relationship_impact": {}
    },
    {
      "summary": "Marcus committed to removing Yolanda from Tuesday shift rotation by speaking to Chen this week, and logged it in his calendar on the spot when she demanded documented follow-through",
      "importance": 3,
      "temporal_anchor": null,
      "is_transient": false,
      "characters_involved": ["Marcus", "Yolanda"],
      "witnesses": ["Marcus", "Yolanda"],
      "location": null,
      "is_secret": false,
      "emotional_impact": {},
      "relationship_impact": { "Marcus→Yolanda": "explicit commitment to resolve three-month schedule grievance, calendar-logged" }
    }
  ]
}`,
    },
    {
        label: 'Timestamp — transient and durable (EN/SFW)',
        input: `Time: 8:45 AM — Thursday, March 6, 2025
Kitchen — Nadia's Apartment — Overcast, 38°F

Lev grabbed his jacket from the back of the chair. "I'll be at the studio until eight, maybe nine."
"I'll save you dinner," Nadia said, not looking up from the stove.
"You don't have to."
"I know." She finally looked at him. "Also — I made the appointment. Couples counseling. First session is the 14th at six."
Lev went still. "Okay," he said, after a moment. "I'll be there."`,
        thinking: `Step 1: Timestamp present; Lev -> studio(until 8-9 PM); Nadia -> save dinner; Nadia -> booked -> counseling(March 14, 6 PM); Lev -> committed -> attend
Step 2: Cross-ref -> no memories of either plan
Step 3: Progression -> two commitments; studio/dinner = tonight(transient); counseling = durable(spans days)
Step 4: Format -> two events; temporal anchor -> strip location + weather; studio = importance 2(transient); counseling = importance 4(durable)`,
        output: `{
  "events": [
    {
      "summary": "Lev told Nadia he would be at the studio until 8 or 9 PM; she offered to save him dinner",
      "importance": 2,
      "temporal_anchor": "Time: 8:45 AM — Thursday, March 6, 2025",
      "is_transient": true,
      "characters_involved": ["Lev", "Nadia"],
      "witnesses": ["Lev", "Nadia"],
      "location": "Nadia's Apartment",
      "is_secret": false,
      "emotional_impact": {},
      "relationship_impact": {}
    },
    {
      "summary": "Nadia booked their first couples counseling session for March 14 at 6 PM; Lev committed to attend after a moment's pause",
      "importance": 4,
      "temporal_anchor": "Time: 8:45 AM — Thursday, March 6, 2025",
      "is_transient": false,
      "characters_involved": ["Nadia", "Lev"],
      "witnesses": ["Nadia", "Lev"],
      "location": null,
      "is_secret": false,
      "emotional_impact": { "Nadia": "resolve", "Lev": "guarded acceptance" },
      "relationship_impact": { "Nadia→Lev": "initiated couples counseling; Lev agreed — first concrete step toward addressing the relationship" }
    }
  ]
}`,
    },
];
