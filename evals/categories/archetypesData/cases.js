/**
 * Cases for the archetypes category.
 *
 * Each case is a situation told in a manager's words, with no modeling vocabulary and no archetype
 * named (the unit tests lint for both), that fits one classic system archetype. It comes with the
 * names the agent is asked to use (`glossary`), the archetype's loops in those names — each with
 * its polarity, the quantities on it and the `core` quantities a diagram's version must keep — and
 * a reference diagram (`links`) that the unit tests check holds every loop with its polarity.
 */

export const ARCHETYPES = [
    'Fixes that Fail',
    'Limits to Growth',
    'Shifting the Burden',
    'Tragedy of the Commons',
    'Escalation',
    'Eroding Goals',
    'Success to the Successful',
    'Growth and Underinvestment',
    'Accidental Adversaries'
];

/**
 * The hard group's distractor: for each archetype a hard situation can have, the archetype most
 * easily mistaken for it, because its story shares the most visible symptom — growth that stalls
 * (Limits to Growth) for a shared resource worn down by several users, two sides each answering the
 * other's moves (Escalation) for partners whose own fixes hurt each other. A hard situation carries
 * a `distractor`: someone's reading of it, in that archetype's terms, told after the narrative. It
 * adds no fact and no quantity; the situation's own facts still fit only its own archetype.
 */
export const DISTRACTOR_OF = {
    'Tragedy of the Commons': 'Limits to Growth',
    'Accidental Adversaries': 'Escalation'
};

const L = (from, to, polarity) => ({ from, to, polarity });

export const cases = {
    'Machine maintenance': {
        archetype: 'Fixes that Fail',
        narrative: 'When the plant falls behind on output, we cut back on preventive maintenance so the machines can run more hours. It works: output catches up within a few weeks. But a few months later the machines start breaking down more often, the plant falls behind again, and we cut maintenance again. This has happened four times in two years, and each time the breakdowns are worse.',
        glossary: ['output shortfall', 'maintenance cutbacks', 'machine running hours', 'breakdowns'],
        loops: [
            { id: 'quick fix', polarity: '-', variables: ['output shortfall', 'maintenance cutbacks', 'machine running hours'], core: ['output shortfall', 'machine running hours'] },
            { id: 'side effect', polarity: '+', variables: ['output shortfall', 'maintenance cutbacks', 'breakdowns', 'machine running hours'], core: ['maintenance cutbacks', 'breakdowns'] }
        ],
        links: [L('output shortfall', 'maintenance cutbacks', '+'), L('maintenance cutbacks', 'machine running hours', '+'), L('machine running hours', 'output shortfall', '-'), L('maintenance cutbacks', 'breakdowns', '+'), L('breakdowns', 'output shortfall', '+')]
    },
    'Restaurant bookings': {
        archetype: 'Limits to Growth',
        narrative: 'When we opened, word about our restaurant spread fast: happy diners told their friends, and bookings climbed every month for a year. Then bookings levelled off and have stayed flat. We cannot fit any more tables into the room, the wait for a table on a busy night has got longer and longer, and more diners now leave unhappy about the wait.',
        glossary: ['bookings', 'happy diners', 'recommendations', 'wait for a table', 'tables'],
        loops: [
            { id: 'word of mouth', polarity: '+', variables: ['bookings', 'happy diners', 'recommendations'], core: ['happy diners', 'recommendations'] },
            { id: 'crowding', polarity: '-', variables: ['bookings', 'wait for a table', 'happy diners', 'recommendations'], core: ['wait for a table', 'bookings'] }
        ],
        links: [L('bookings', 'happy diners', '+'), L('happy diners', 'recommendations', '+'), L('recommendations', 'bookings', '+'), L('bookings', 'wait for a table', '+'), L('wait for a table', 'happy diners', '-'), L('tables', 'wait for a table', '-')]
    },
    'Sales promotions': {
        archetype: 'Shifting the Burden',
        narrative: 'Whenever our sales team looks like missing its monthly target, we run a discount promotion, and sales jump that month. Training the salespeople to sell better would take months to pay off, and with the promotions bringing in the numbers there is never time or budget for training. Over the years the team\'s selling skills have slipped, the shortfalls come more often, and we run more promotions than ever.',
        glossary: ['sales shortfall', 'discount promotions', 'sales training', 'selling skills'],
        loops: [
            { id: 'symptomatic fix', polarity: '-', variables: ['sales shortfall', 'discount promotions'], core: ['sales shortfall', 'discount promotions'] },
            { id: 'fundamental solution', polarity: '-', variables: ['sales shortfall', 'sales training', 'selling skills'], core: ['sales training', 'selling skills'] },
            { id: 'dependence', polarity: '+', variables: ['sales shortfall', 'discount promotions', 'sales training', 'selling skills'], core: ['discount promotions', 'selling skills'] }
        ],
        links: [L('sales shortfall', 'discount promotions', '+'), L('discount promotions', 'sales shortfall', '-'), L('sales shortfall', 'sales training', '+'), L('sales training', 'selling skills', '+'), L('selling skills', 'sales shortfall', '-'), L('discount promotions', 'sales training', '-')]
    },
    'Shared lake': {
        archetype: 'Tragedy of the Commons',
        narrative: 'Two villages, Northby and Southby, fish the same lake. In each village, the more fish the boats land, the more boats the village buys, so both fleets have been growing for years, and for years both villages\' catches grew. Lately there are far fewer fish in the lake, each boat catches less than it used to, and both villages\' catches are falling.',
        distractor: 'Our harbour master\'s view is that both villages have simply grown as big as a fishing village can, like a shop that already has every customer in town: there are only so many people at the market to buy fish, and the answer is to find buyers further afield.',
        glossary: ['Northby boats', 'Northby catch', 'Southby boats', 'Southby catch', 'fish in the lake', 'catch per boat'],
        loops: [
            { id: 'Northby growth', polarity: '+', variables: ['Northby boats', 'Northby catch'], core: ['Northby boats', 'Northby catch'] },
            { id: 'Southby growth', polarity: '+', variables: ['Southby boats', 'Southby catch'], core: ['Southby boats', 'Southby catch'] },
            { id: 'Northby depletion', polarity: '-', variables: ['Northby catch', 'fish in the lake', 'catch per boat', 'Northby boats'], core: ['Northby catch', 'fish in the lake'] },
            { id: 'Southby depletion', polarity: '-', variables: ['Southby catch', 'fish in the lake', 'catch per boat', 'Southby boats'], core: ['Southby catch', 'fish in the lake'] }
        ],
        links: [L('Northby boats', 'Northby catch', '+'), L('Northby catch', 'Northby boats', '+'), L('Southby boats', 'Southby catch', '+'), L('Southby catch', 'Southby boats', '+'), L('Northby catch', 'fish in the lake', '-'), L('Southby catch', 'fish in the lake', '-'), L('fish in the lake', 'catch per boat', '+'), L('catch per boat', 'Northby catch', '+'), L('catch per boat', 'Southby catch', '+')]
    },
    'Rival stores': {
        archetype: 'Escalation',
        narrative: 'Corner Hardware and Main Street Hardware sit on the same street. Whenever one of them runs a bigger advertising campaign than the other, the one that has fallen behind answers with a bigger campaign of its own to catch up. Neither has gained customers from it, but advertising spending at both stores has climbed every year for five years.',
        glossary: ['Corner advertising', 'Main Street advertising', 'Corner falling behind', 'Main Street falling behind'],
        loops: [
            { id: 'Corner catching up', polarity: '-', variables: ['Corner advertising', 'Corner falling behind'], core: ['Corner advertising', 'Corner falling behind'] },
            { id: 'Main Street catching up', polarity: '-', variables: ['Main Street advertising', 'Main Street falling behind'], core: ['Main Street advertising', 'Main Street falling behind'] },
            { id: 'arms race', polarity: '+', variables: ['Corner advertising', 'Main Street falling behind', 'Main Street advertising', 'Corner falling behind'], core: ['Corner advertising', 'Main Street advertising'] }
        ],
        links: [L('Corner advertising', 'Main Street falling behind', '+'), L('Main Street falling behind', 'Main Street advertising', '+'), L('Main Street advertising', 'Corner falling behind', '+'), L('Corner falling behind', 'Corner advertising', '+'), L('Corner advertising', 'Corner falling behind', '-'), L('Main Street advertising', 'Main Street falling behind', '-')]
    },
    'Call bell standard': {
        heldOut: true,
        archetype: 'Eroding Goals',
        narrative: 'On our ward we set a standard that nine in ten call bells are answered within five minutes. When we fall short of it, we bring in agency nurses, and that does lift the numbers, but getting them approved takes weeks and they cost a fortune. Meanwhile the shortfall sits on the monthly report and the board keeps asking why we are missing. Each time it has been easier to agree that the standard was unrealistic and lower it a little: first to eight in ten, then to seven in ten. The shortfall on the report goes away, we book fewer agency nurses, and patients now wait longer for help than they did three years ago.',
        glossary: ['call bell standard', 'call bells answered quickly', 'shortfall from the standard', 'agency nurses', 'pressure to relax the standard'],
        loops: [
            { id: 'corrective action', polarity: '-', variables: ['shortfall from the standard', 'agency nurses', 'call bells answered quickly'], core: ['agency nurses', 'shortfall from the standard'] },
            { id: 'lowering the standard', polarity: '-', variables: ['shortfall from the standard', 'pressure to relax the standard', 'call bell standard'], core: ['pressure to relax the standard', 'call bell standard'] }
        ],
        links: [L('call bell standard', 'shortfall from the standard', '+'), L('call bells answered quickly', 'shortfall from the standard', '-'), L('shortfall from the standard', 'agency nurses', '+'), L('agency nurses', 'call bells answered quickly', '+'), L('shortfall from the standard', 'pressure to relax the standard', '+'), L('pressure to relax the standard', 'call bell standard', '-')]
    },
    'Orchestra and choir': {
        heldOut: true,
        archetype: 'Success to the Successful',
        narrative: 'At our school the head of music splits the hall\'s weekly rehearsal slots between the orchestra and the choir, and gives more slots to whichever group did better at the last regional competition. Three years ago the two were about even. The orchestra placed a little higher one year, got a few extra slots, played better the next year, placed higher again and got more slots still. The choir has lost slots every year, its results have slipped, and some parents now say the choir children are simply less talented.',
        glossary: ['orchestra share of rehearsal slots', 'orchestra rehearsal time', 'choir rehearsal time', 'orchestra results', 'choir results'],
        loops: [
            { id: 'orchestra pulls ahead', polarity: '+', variables: ['orchestra share of rehearsal slots', 'orchestra rehearsal time', 'orchestra results'], core: ['orchestra results', 'orchestra share of rehearsal slots'] },
            { id: 'choir falls behind', polarity: '+', variables: ['orchestra share of rehearsal slots', 'choir rehearsal time', 'choir results'], core: ['choir results', 'orchestra share of rehearsal slots'] }
        ],
        links: [L('orchestra share of rehearsal slots', 'orchestra rehearsal time', '+'), L('orchestra share of rehearsal slots', 'choir rehearsal time', '-'), L('orchestra rehearsal time', 'orchestra results', '+'), L('choir rehearsal time', 'choir results', '+'), L('orchestra results', 'orchestra share of rehearsal slots', '+'), L('choir results', 'orchestra share of rehearsal slots', '-')]
    },
    'Vegetable box co-op': {
        heldOut: true,
        archetype: 'Growth and Underinvestment',
        narrative: 'Our farm co-op packs a weekly vegetable box, and for three years subscribers grew fast because each new subscriber told friends and neighbours about it. This year the packing shed cannot keep up: more boxes go out late, and subscribers who get a late box cancel. We could build a bigger shed, but the board only approves the money once late boxes are already a problem, and a new shed takes most of a year to build and fit out. By the time the extra space opens we have outgrown it, the late boxes come back, and so do the cancellations. Subscriber numbers have been flat for a year.',
        glossary: ['box subscribers', 'referrals', 'late deliveries', 'packing capacity', 'packing shed investment'],
        loops: [
            { id: 'word of mouth', polarity: '+', variables: ['box subscribers', 'referrals'], core: ['referrals', 'box subscribers'] },
            { id: 'late boxes', polarity: '-', variables: ['box subscribers', 'late deliveries'], core: ['late deliveries', 'box subscribers'] },
            { id: 'investment', polarity: '-', variables: ['late deliveries', 'packing shed investment', 'packing capacity'], core: ['packing shed investment', 'packing capacity'] }
        ],
        links: [L('box subscribers', 'referrals', '+'), L('referrals', 'box subscribers', '+'), L('box subscribers', 'late deliveries', '+'), L('late deliveries', 'box subscribers', '-'), L('late deliveries', 'packing shed investment', '+'), L('packing shed investment', 'packing capacity', '+'), L('packing capacity', 'late deliveries', '-')]
    },
    'Fundraisers and programmes': {
        heldOut: true,
        archetype: 'Accidental Adversaries',
        narrative: 'At our charity the fundraising team and the programmes team need each other. The money the fundraisers raise pays for the projects, and good results in the field give the fundraisers the stories and site visits that persuade donors to give more. A couple of years ago the fundraisers found that donors give more when they can tie a gift to one project with its own conditions and reports, and since it works they chase those gifts harder every year. The programmes team found that their results improve when field staff are shielded from interruptions, and since that works they guard the time more and more, and now turn down most requests for stories and visits. But every gift with conditions ties field staff up in special reporting, which hurts results in the field, and every refused visit makes the next donor harder to win. Each team now thinks the other is working against it.',
        distractor: 'Our director sees it as a turf war: each team keeps raising the stakes to get one over on the other, every move answered by a bigger one, and she wants them to call a truce.',
        glossary: ['donations raised', 'funding for programmes', 'programme results', 'field stories for donors', 'restricted pledges', 'staff time kept for fieldwork'],
        loops: [
            { id: 'partnership', polarity: '+', variables: ['donations raised', 'funding for programmes', 'programme results', 'field stories for donors'], core: ['funding for programmes', 'field stories for donors'] },
            { id: 'fundraisers\' own fix', polarity: '+', variables: ['donations raised', 'restricted pledges'], core: ['restricted pledges', 'donations raised'] },
            { id: 'programmes\' own fix', polarity: '+', variables: ['programme results', 'staff time kept for fieldwork'], core: ['staff time kept for fieldwork', 'programme results'] },
            { id: 'working against each other', polarity: '+', variables: ['restricted pledges', 'programme results', 'staff time kept for fieldwork', 'field stories for donors', 'donations raised'], core: ['restricted pledges', 'staff time kept for fieldwork'] }
        ],
        links: [L('donations raised', 'funding for programmes', '+'), L('funding for programmes', 'programme results', '+'), L('programme results', 'field stories for donors', '+'), L('field stories for donors', 'donations raised', '+'), L('donations raised', 'restricted pledges', '+'), L('restricted pledges', 'donations raised', '+'), L('restricted pledges', 'programme results', '-'), L('programme results', 'staff time kept for fieldwork', '+'), L('staff time kept for fieldwork', 'programme results', '+'), L('staff time kept for fieldwork', 'field stories for donors', '-')]
    },
    'Support ticket promise': {
        heldOut: true,
        archetype: 'Eroding Goals',
        narrative: 'Each quarter our support team sets a target for the share of tickets solved in the very first reply, and we set it from how far we fell short last quarter: the bigger the miss, the more we trim the next target so it feels fair to the agents. When we do fall short, the remedy we know works is having agents write help articles that the whole team can draw on, but writing them takes agents off the queue for weeks and the benefit only shows a quarter or two later. Most quarters the miss arrives before the articles do, so the next target comes down. Four years ago the target was seven tickets in ten; today it is four in ten, and nobody remembers deciding that.',
        glossary: ['first-reply target', 'tickets solved in the first reply', 'gap to the target', 'help articles written'],
        loops: [
            { id: 'corrective action', polarity: '-', variables: ['gap to the target', 'help articles written', 'tickets solved in the first reply'], core: ['help articles written', 'gap to the target'] },
            { id: 'lowering the target', polarity: '-', variables: ['gap to the target', 'first-reply target'], core: ['gap to the target', 'first-reply target'] }
        ],
        links: [L('first-reply target', 'gap to the target', '+'), L('tickets solved in the first reply', 'gap to the target', '-'), L('gap to the target', 'help articles written', '+'), L('help articles written', 'tickets solved in the first reply', '+'), L('gap to the target', 'first-reply target', '-')]
    },
    'Branch libraries': {
        heldOut: true,
        archetype: 'Success to the Successful',
        narrative: 'The county splits its new-book budget between the Riverside and Hillcrest branch libraries according to how many loans each made the year before. Riverside was slightly busier one year, got a little more money for new books, had fresher shelves, lent more, and got more money again the next year. Hillcrest\'s shelves have grown older every year, its loans have dropped, and the county is now talking about cutting its opening hours because so few people use it.',
        glossary: ['Riverside share of the book budget', 'Riverside new books', 'Hillcrest new books', 'Riverside loans', 'Hillcrest loans'],
        loops: [
            { id: 'Riverside pulls ahead', polarity: '+', variables: ['Riverside share of the book budget', 'Riverside new books', 'Riverside loans'], core: ['Riverside loans', 'Riverside share of the book budget'] },
            { id: 'Hillcrest falls behind', polarity: '+', variables: ['Riverside share of the book budget', 'Hillcrest new books', 'Hillcrest loans'], core: ['Hillcrest loans', 'Riverside share of the book budget'] }
        ],
        links: [L('Riverside share of the book budget', 'Riverside new books', '+'), L('Riverside share of the book budget', 'Hillcrest new books', '-'), L('Riverside new books', 'Riverside loans', '+'), L('Hillcrest new books', 'Hillcrest loans', '+'), L('Riverside loans', 'Riverside share of the book budget', '+'), L('Hillcrest loans', 'Riverside share of the book budget', '-')]
    },
    'Running club': {
        heldOut: true,
        archetype: 'Growth and Underinvestment',
        narrative: 'Our running club grew quickly because members bring their friends along, and membership roughly doubled every year. Lately the Tuesday and Thursday sessions are so crowded that the coaches cannot give anyone attention; newer runners feel ignored and drop out, and membership has stopped growing. We could train more volunteer coaches, but the committee only pays for coaching courses once members are already complaining, and a new coach takes most of a season to qualify. By the time the new coaches are ready the sessions are crowded again.',
        glossary: ['members', 'friends brought along', 'runners per coach', 'qualified coaches', 'coaching course funding'],
        loops: [
            { id: 'word of mouth', polarity: '+', variables: ['members', 'friends brought along'], core: ['friends brought along', 'members'] },
            { id: 'crowded sessions', polarity: '-', variables: ['members', 'runners per coach'], core: ['runners per coach', 'members'] },
            { id: 'investment', polarity: '-', variables: ['runners per coach', 'coaching course funding', 'qualified coaches'], core: ['coaching course funding', 'qualified coaches'] }
        ],
        links: [L('members', 'friends brought along', '+'), L('friends brought along', 'members', '+'), L('members', 'runners per coach', '+'), L('runners per coach', 'members', '-'), L('runners per coach', 'coaching course funding', '+'), L('coaching course funding', 'qualified coaches', '+'), L('qualified coaches', 'runners per coach', '-')]
    },
    'Buses and downtown shops': {
        heldOut: true,
        archetype: 'Accidental Adversaries',
        narrative: 'The city transit agency and the downtown business association used to get along well. The more people rode the buses, the more frequent a downtown service the agency could afford, which brought shoppers into the shops; and the better the shops did, the more the association put into bus shelters and bus passes for shop staff, which brought in more riders. Then the agency started running express routes that skip downtown to win riders, and riders liked them, so it kept adding more. The shops lost foot traffic from those routes and began offering free parking to shoppers who drive, and that worked for them, so they kept offering more. Free parking pulls people off the buses. Each side now thinks the other is out to hurt it.',
        distractor: 'The mayor calls it a feud: every time one side makes a move, the other hits back harder, and he wants both to agree to stop before it goes any further.',
        glossary: ['ridership', 'downtown service', 'shop sales', 'business support for transit', 'express routes skipping downtown', 'free parking offers'],
        loops: [
            { id: 'partnership', polarity: '+', variables: ['ridership', 'downtown service', 'shop sales', 'business support for transit'], core: ['downtown service', 'business support for transit'] },
            { id: 'agency\'s own fix', polarity: '+', variables: ['ridership', 'express routes skipping downtown'], core: ['express routes skipping downtown', 'ridership'] },
            { id: 'shops\' own fix', polarity: '+', variables: ['shop sales', 'free parking offers'], core: ['free parking offers', 'shop sales'] },
            { id: 'working against each other', polarity: '+', variables: ['express routes skipping downtown', 'shop sales', 'free parking offers', 'ridership'], core: ['express routes skipping downtown', 'free parking offers'] }
        ],
        links: [L('ridership', 'downtown service', '+'), L('downtown service', 'shop sales', '+'), L('shop sales', 'business support for transit', '+'), L('business support for transit', 'ridership', '+'), L('ridership', 'express routes skipping downtown', '+'), L('express routes skipping downtown', 'ridership', '+'), L('express routes skipping downtown', 'shop sales', '-'), L('shop sales', 'free parking offers', '+'), L('free parking offers', 'shop sales', '+'), L('free parking offers', 'ridership', '-')]
    },
    'Newspaper subscriptions': {
        heldOut: true,
        archetype: 'Fixes that Fail',
        narrative: 'Our local newspaper runs on subscriptions. Whenever the year\'s subscription money looks like coming in short, we raise the subscription price, and the money per subscriber goes up at once, so the year\'s accounts come out right. But readers do not cancel straight away; they cancel at renewal time, months later, when they see the new price. With fewer subscribers the money falls short again, and we raise the price again. We have done this three years running, and each year more readers leave at renewal.',
        glossary: ['revenue shortfall', 'subscription price', 'revenue per subscriber', 'cancellations', 'subscribers'],
        loops: [
            { id: 'quick fix', polarity: '-', variables: ['revenue shortfall', 'subscription price', 'revenue per subscriber'], core: ['subscription price', 'revenue per subscriber'] },
            { id: 'side effect', polarity: '+', variables: ['revenue shortfall', 'subscription price', 'cancellations', 'subscribers'], core: ['cancellations', 'subscribers'] }
        ],
        links: [L('revenue shortfall', 'subscription price', '+'), L('subscription price', 'revenue per subscriber', '+'), L('revenue per subscriber', 'revenue shortfall', '-'), L('subscription price', 'cancellations', '+'), L('cancellations', 'subscribers', '-'), L('subscribers', 'revenue shortfall', '-')]
    },
    'Coding bootcamp': {
        heldOut: true,
        archetype: 'Limits to Growth',
        narrative: 'Our coding bootcamp grew on the strength of its graduates. Every graduate who landed a developer job posted about it, those posts brought in the next class, and for four years each class was bigger than the last. This year applications have stopped rising. There are only so many junior developer openings in the region, and with more of our graduates going after the same openings, a smaller share of each class finds a job within six months. Fewer hires means fewer posts, and the classes have stopped growing.',
        glossary: ['enrolments', 'graduates hired', 'success stories', 'graduates per local opening', 'placement rate', 'local junior openings'],
        loops: [
            { id: 'success stories', polarity: '+', variables: ['enrolments', 'graduates hired', 'success stories'], core: ['graduates hired', 'success stories'] },
            { id: 'job market', polarity: '-', variables: ['enrolments', 'graduates per local opening', 'placement rate', 'graduates hired', 'success stories'], core: ['graduates per local opening', 'placement rate'] }
        ],
        links: [L('enrolments', 'graduates hired', '+'), L('graduates hired', 'success stories', '+'), L('success stories', 'enrolments', '+'), L('enrolments', 'graduates per local opening', '+'), L('local junior openings', 'graduates per local opening', '-'), L('graduates per local opening', 'placement rate', '-'), L('placement rate', 'graduates hired', '+')]
    },
    'Building firm owner': {
        heldOut: true,
        archetype: 'Shifting the Burden',
        narrative: 'I own a small building firm with four site foremen. When a job starts running behind schedule, I go to the site and take over the decisions myself, and the job catches up within a week or two. What the foremen really need is time with me going over how to plan a job, but that takes months to show and I am always busy rescuing the next job. Worse, every time I take over, the foreman on that site misses the chance to learn by running it, so the foremen today are no better at keeping jobs on schedule than they were five years ago, and I spend more of my week on sites than ever.',
        glossary: ['schedule slippage', 'owner taking over', 'coaching for foremen', 'foremen\'s experience running jobs'],
        loops: [
            { id: 'symptomatic fix', polarity: '-', variables: ['schedule slippage', 'owner taking over'], core: ['schedule slippage', 'owner taking over'] },
            { id: 'fundamental solution', polarity: '-', variables: ['schedule slippage', 'coaching for foremen', 'foremen\'s experience running jobs'], core: ['coaching for foremen', 'foremen\'s experience running jobs'] },
            { id: 'side effect', polarity: '+', variables: ['schedule slippage', 'owner taking over', 'foremen\'s experience running jobs'], core: ['owner taking over', 'foremen\'s experience running jobs'] }
        ],
        links: [L('schedule slippage', 'owner taking over', '+'), L('owner taking over', 'schedule slippage', '-'), L('schedule slippage', 'coaching for foremen', '+'), L('coaching for foremen', 'foremen\'s experience running jobs', '+'), L('foremen\'s experience running jobs', 'schedule slippage', '-'), L('owner taking over', 'foremen\'s experience running jobs', '-')]
    },
    'Reef snorkel trips': {
        heldOut: true,
        archetype: 'Tragedy of the Commons',
        narrative: 'Two resorts in our bay, Seaview and Palm Cove, both run snorkel trips out to the same reef. At each resort, the more trips it runs, the more glowing reviews it gets and the more guests it books, and the more guests it has, the more trips it runs. For years both resorts grew this way. But all those boats and swimmers are wearing the reef down: there is less coral and fewer fish, each trip is less impressive than it used to be, and bookings at both resorts have started to slide.',
        distractor: 'The tourism board says the bay has simply filled up, the way any holiday spot does once every room is booked in high season, and that the answer is to build more rooms so both resorts can keep growing.',
        glossary: ['Seaview guests', 'Seaview reef trips', 'Palm Cove guests', 'Palm Cove reef trips', 'reef health', 'trip quality'],
        loops: [
            { id: 'Seaview growth', polarity: '+', variables: ['Seaview guests', 'Seaview reef trips'], core: ['Seaview guests', 'Seaview reef trips'] },
            { id: 'Palm Cove growth', polarity: '+', variables: ['Palm Cove guests', 'Palm Cove reef trips'], core: ['Palm Cove guests', 'Palm Cove reef trips'] },
            { id: 'Seaview wear', polarity: '-', variables: ['Seaview reef trips', 'reef health', 'trip quality', 'Seaview guests'], core: ['Seaview reef trips', 'reef health'] },
            { id: 'Palm Cove wear', polarity: '-', variables: ['Palm Cove reef trips', 'reef health', 'trip quality', 'Palm Cove guests'], core: ['Palm Cove reef trips', 'reef health'] }
        ],
        links: [L('Seaview guests', 'Seaview reef trips', '+'), L('Seaview reef trips', 'Seaview guests', '+'), L('Palm Cove guests', 'Palm Cove reef trips', '+'), L('Palm Cove reef trips', 'Palm Cove guests', '+'), L('Seaview reef trips', 'reef health', '-'), L('Palm Cove reef trips', 'reef health', '-'), L('reef health', 'trip quality', '+'), L('trip quality', 'Seaview guests', '+'), L('trip quality', 'Palm Cove guests', '+')]
    },
    'Neighbouring towns': {
        heldOut: true,
        archetype: 'Escalation',
        narrative: 'Ashford and Brookley sit side by side on the same motorway, and both councils want the warehouses and offices that are looking for a site. A bigger tax break from one town wins employers away from the other. When employers start choosing Brookley, Ashford\'s council raises its own tax break to win them back, and when employers start choosing Ashford, Brookley raises its break. Ten years on, both towns give away far more in tax breaks than they did, and neither has more employers to show for it.',
        glossary: ['Ashford tax breaks', 'Brookley tax breaks', 'employers choosing Ashford', 'employers choosing Brookley'],
        loops: [
            { id: 'Ashford answers', polarity: '-', variables: ['Ashford tax breaks', 'employers choosing Brookley'], core: ['Ashford tax breaks', 'employers choosing Brookley'] },
            { id: 'Brookley answers', polarity: '-', variables: ['Brookley tax breaks', 'employers choosing Ashford'], core: ['Brookley tax breaks', 'employers choosing Ashford'] },
            { id: 'bidding war', polarity: '+', variables: ['Ashford tax breaks', 'employers choosing Ashford', 'Brookley tax breaks', 'employers choosing Brookley'], core: ['Ashford tax breaks', 'Brookley tax breaks'] }
        ],
        links: [L('Ashford tax breaks', 'employers choosing Ashford', '+'), L('Ashford tax breaks', 'employers choosing Brookley', '-'), L('Brookley tax breaks', 'employers choosing Brookley', '+'), L('Brookley tax breaks', 'employers choosing Ashford', '-'), L('employers choosing Ashford', 'Brookley tax breaks', '+'), L('employers choosing Brookley', 'Ashford tax breaks', '+')]
    }
};

export const HELD_OUT_ARCHETYPES = Object.keys(cases).filter((k) => cases[k].heldOut);
