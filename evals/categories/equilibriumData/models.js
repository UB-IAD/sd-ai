/**
 * The models the equilibrium category hands to engines, and a known equilibrium solution for each.
 *
 * Every model here starts out of equilibrium on purpose. Each case says which equations the
 * engine may change (stock initial values, and sometimes a constant), and carries one solution
 * that is known to hold every stock steady, so the test suite can prove the case is solvable
 * within the rules it states. The solution is never shown to the engine.
 *
 * Models are written out in full rather than generated: they are small, and a reviewer should be
 * able to read each one and check its equilibrium by hand.
 */

/**
 * Build relationships from equations so the sd-json is complete. Every reference becomes a link;
 * links listed in `negative` (as "from->to") get a negative polarity, everything else positive.
 * Stock-to-flow structure is expressed by the stock's inflows and outflows, as sd-json does.
 */
const relationshipsFor = function(variables, negative) {
    const fold = (n) => n.replace(/[\s_]+/g, '_').toLowerCase();
    const byFolded = new Map(variables.map((v) => [fold(v.name), v.name]));
    const relationships = [];
    for (const variable of variables) {
        if (variable.type === 'stock') continue;
        const seen = new Set();
        for (const match of String(variable.equation).matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
            const from = byFolded.get(fold(match[0]));
            if (!from || from === variable.name || seen.has(from)) continue;
            seen.add(from);
            const key = `${from}->${variable.name}`;
            relationships.push({ from, to: variable.name, polarity: negative.includes(key) ? '-' : '+' });
        }
    }
    for (const stock of variables.filter((v) => v.type === 'stock')) {
        for (const inflow of stock.inflows || []) relationships.push({ from: inflow, to: stock.name, polarity: '+' });
        for (const outflow of stock.outflows || []) relationships.push({ from: outflow, to: stock.name, polarity: '-' });
    }
    return relationships;
};

const stock = (name, equation, inflows, outflows, units) => ({ name, type: 'stock', equation: String(equation), inflows, outflows, units });
const flow = (name, equation, units) => ({ name, type: 'flow', equation, units });
const aux = (name, equation, units) => ({ name, type: 'variable', equation: String(equation), units });

const model = function(variables, specs, negative) {
    return { variables, relationships: relationshipsFor(variables, negative), specs };
};

export const cases = {
    "Cooling Coffee": {
        group: "simpleEquilibrium",
        description: "a cup of coffee cooling toward room temperature",
        model: model([
            stock("Coffee Temperature", 90, [], ["cooling"], "degrees C"),
            flow("cooling", "(Coffee_Temperature - Room_Temperature) / cooling_time", "degrees C/minute"),
            aux("Room Temperature", 20, "degrees C"),
            aux("cooling time", 10, "minutes")
        ], { startTime: 0, stopTime: 60, dt: 0.25, timeUnits: "minutes" }, ["Room Temperature->cooling", "cooling time->cooling"]),
        adjustable: ["Coffee Temperature"],
        equilibriumStocks: ["Coffee Temperature"],
        solution: { "Coffee Temperature": "20" }
    },
    "Reservoir": {
        group: "simpleEquilibrium",
        description: "a reservoir fed by a river and drained by releases proportional to the water stored",
        model: model([
            stock("Water in Reservoir", 100, ["river inflow"], ["release"], "megaliters"),
            flow("river inflow", "inflow_rate", "megaliters/day"),
            flow("release", "Water_in_Reservoir / residence_time", "megaliters/day"),
            aux("inflow rate", 50, "megaliters/day"),
            aux("residence time", 4, "days")
        ], { startTime: 0, stopTime: 40, dt: 0.125, timeUnits: "days" }, ["residence time->release"]),
        adjustable: ["Water in Reservoir"],
        equilibriumStocks: ["Water in Reservoir"],
        nonTrivial: { "Water in Reservoir": 1 },
        solution: { "Water in Reservoir": "200" }
    },
    "Town Population": {
        group: "simpleEquilibrium",
        description: "a town population with births, deaths and a steady stream of newcomers",
        model: model([
            stock("Population", 1000, ["births", "immigration"], ["deaths"], "people"),
            flow("births", "Population * birth_fraction", "people/year"),
            flow("deaths", "Population / average_lifetime", "people/year"),
            flow("immigration", "newcomers_per_year", "people/year"),
            aux("birth fraction", 0.02, "1/year"),
            aux("average lifetime", 40, "years"),
            aux("newcomers per year", 10, "people/year")
        ], { startTime: 0, stopTime: 50, dt: 0.25, timeUnits: "years" }, ["average lifetime->deaths"]),
        adjustable: ["newcomers per year"],
        frozen: "Keep the initial Population at 1000.",
        equilibriumStocks: ["Population"],
        fixedInitial: { "Population": 1000 },
        solution: { "newcomers per year": "5" }
    },
    "Inventory and Workforce": {
        group: "mediumEquilibrium",
        description: "a factory that sets its workforce from expected demand and its inventory gap",
        model: model([
            stock("Inventory", 50, ["producing"], ["shipping"], "widgets"),
            stock("Workers", 4, ["net hiring"], [], "people"),
            stock("Expected Demand", 10, ["changing expectations"], [], "widgets/month"),
            flow("producing", "Workers * productivity", "widgets/month"),
            flow("shipping", "demand", "widgets/month"),
            flow("net hiring", "(desired_workers - Workers) / time_to_hire", "people/month"),
            flow("changing expectations", "(demand - Expected_Demand) / time_to_adjust_expectations", "widgets/month/month"),
            aux("demand", 20, "widgets/month"),
            aux("productivity", 2, "widgets/person/month"),
            aux("desired inventory", 100, "widgets"),
            aux("inventory adjustment time", 2, "months"),
            aux("desired production", "Expected_Demand + (desired_inventory - Inventory) / inventory_adjustment_time", "widgets/month"),
            aux("desired workers", "desired_production / productivity", "people"),
            aux("time to hire", 6, "months"),
            aux("time to adjust expectations", 4, "months")
        ], { startTime: 0, stopTime: 120, dt: 0.0625, timeUnits: "months" },
        ["Workers->net hiring", "time to hire->net hiring", "Expected Demand->changing expectations", "time to adjust expectations->changing expectations", "Inventory->desired production", "inventory adjustment time->desired production", "productivity->desired workers"]),
        adjustable: ["Inventory", "Workers", "Expected Demand"],
        equilibriumStocks: ["Inventory", "Workers", "Expected Demand"],
        nonTrivial: { "Workers": 1 },
        solution: { "Inventory": "100", "Workers": "10", "Expected Demand": "20" }
    },
    "Endemic Infection": {
        group: "mediumEquilibrium",
        description: "an infection that persists in a population with births and deaths",
        model: model([
            stock("Susceptible", 9990, ["births"], ["infecting", "susceptible deaths"], "people"),
            stock("Infected", 10, ["infecting"], ["recovering", "infected deaths"], "people"),
            stock("Recovered", 0, ["recovering"], ["recovered deaths"], "people"),
            flow("births", "total_population * death_rate", "people/year"),
            flow("infecting", "transmission_rate * Susceptible * Infected / total_population", "people/year"),
            flow("recovering", "Infected / illness_duration", "people/year"),
            flow("susceptible deaths", "Susceptible * death_rate", "people/year"),
            flow("infected deaths", "Infected * death_rate", "people/year"),
            flow("recovered deaths", "Recovered * death_rate", "people/year"),
            aux("total population", "Susceptible + Infected + Recovered", "people"),
            aux("transmission rate", 50, "1/year"),
            aux("illness duration", 0.1, "years"),
            aux("death rate", 0.02, "1/year")
        ], { startTime: 0, stopTime: 40, dt: 0.005, timeUnits: "years" },
        ["illness duration->recovering", "total population->infecting"]),
        adjustable: ["Susceptible", "Infected", "Recovered"],
        frozen: "Keep the total initial population (Susceptible + Infected + Recovered) at 10,000 people, and keep the infection present (at least one infected person).",
        equilibriumStocks: ["Susceptible", "Infected", "Recovered"],
        fixedTotal: { stocks: ["Susceptible", "Infected", "Recovered"], total: 10000 },
        nonTrivial: { "Infected": 1 },
        // R0 = 50 / (10 + 0.02) = 4.99002; S* = N / R0; I* = mu N (1 - 1/R0) / (gamma + mu)
        solution: { "Susceptible": "2004", "Infected": "15.9601", "Recovered": "7980.0399" }
    },
    "Project Backlog and Staff": {
        group: "complexEquilibrium",
        description: "a project office whose staffing follows its backlog, with a running count of completed projects",
        model: model([
            stock("Backlog", 300, ["new projects"], ["completing"], "projects"),
            stock("Staff", 5, ["staff change"], [], "people"),
            stock("Completed Projects", 0, ["completing"], [], "projects"),
            flow("new projects", "project_arrivals", "projects/month"),
            flow("completing", "Staff * productivity", "projects/month"),
            flow("staff change", "(desired_staff - Staff) / time_to_adjust_staff", "people/month"),
            aux("project arrivals", 40, "projects/month"),
            aux("productivity", 2, "projects/person/month"),
            aux("target delivery time", 3, "months"),
            aux("desired staff", "Backlog / target_delivery_time / productivity", "people"),
            aux("time to adjust staff", 4, "months")
        ], { startTime: 0, stopTime: 120, dt: 0.0625, timeUnits: "months" },
        ["Staff->staff change", "time to adjust staff->staff change", "target delivery time->desired staff", "productivity->desired staff"]),
        adjustable: ["Backlog", "Staff"],
        frozen: "Completed Projects only ever accumulates, so it cannot be in equilibrium; leave it as it is.",
        equilibriumStocks: ["Backlog", "Staff"],
        nonTrivial: { "Staff": 1 },
        solution: { "Backlog": "120", "Staff": "20" }
    },
    "Predators and Prey": {
        group: "complexEquilibrium",
        description: "a prey population with limited food and a predator population that lives off it",
        model: model([
            stock("Prey", 800, ["prey births"], ["prey eaten"], "animals"),
            stock("Predators", 50, ["predator births"], ["predator deaths"], "animals"),
            flow("prey births", "prey_growth_rate * Prey * (1 - Prey / carrying_capacity)", "animals/year"),
            flow("prey eaten", "predation_rate * Prey * Predators", "animals/year"),
            flow("predator births", "conversion_efficiency * prey_eaten", "animals/year"),
            flow("predator deaths", "predator_death_rate * Predators", "animals/year"),
            aux("prey growth rate", 0.5, "1/year"),
            aux("carrying capacity", 1000, "animals"),
            aux("predation rate", 0.001, "1/(animal*year)"),
            aux("conversion efficiency", 0.5, "dimensionless"),
            aux("predator death rate", 0.2, "1/year")
        ], { startTime: 0, stopTime: 100, dt: 0.03125, timeUnits: "years" },
        ["carrying capacity->prey births"]),
        adjustable: ["Prey", "Predators"],
        frozen: "Both populations must stay present (at least one animal each).",
        equilibriumStocks: ["Prey", "Predators"],
        nonTrivial: { "Prey": 1, "Predators": 1 },
        solution: { "Prey": "400", "Predators": "300" }
    },
    "Population Aging Chain": {
        group: "complexEquilibrium",
        description: "a population moving through childhood, adulthood and old age",
        model: model([
            stock("Children", 9000, ["births"], ["maturing"], "people"),
            stock("Adults", 15000, ["maturing"], ["aging"], "people"),
            stock("Elders", 6000, ["aging"], ["deaths"], "people"),
            flow("births", "Adults * fertility", "people/year"),
            flow("maturing", "Children / years_as_child", "people/year"),
            flow("aging", "Adults / years_as_adult", "people/year"),
            flow("deaths", "Elders / years_as_elder", "people/year"),
            aux("fertility", 0.03, "1/year"),
            aux("years as child", 15, "years"),
            aux("years as adult", 45, "years"),
            aux("years as elder", 15, "years")
        ], { startTime: 0, stopTime: 200, dt: 0.25, timeUnits: "years" },
        ["years as child->maturing", "years as adult->aging", "years as elder->deaths"]),
        adjustable: ["Children", "Adults", "Elders", "fertility"],
        frozen: "Keep the total initial population (Children + Adults + Elders) at 30,000 people.",
        equilibriumStocks: ["Children", "Adults", "Elders"],
        fixedTotal: { stocks: ["Children", "Adults", "Elders"], total: 30000 },
        nonTrivial: { "Children": 1, "Adults": 1, "Elders": 1 },
        solution: { "Children": "6000", "Adults": "18000", "Elders": "6000", "fertility": "0.0222222222" }
    },
    "Library Book Loans": {
        group: "simpleEquilibrium",
        heldOut: true,
        description: "a lending library whose books move between its shelves and its borrowers",
        model: model([
            stock("Books on Shelves", 12000, ["returning"], ["lending"], "books"),
            stock("Books on Loan", 0, ["lending"], ["returning"], "books"),
            flow("lending", "Books_on_Shelves * borrowing_fraction", "books/week"),
            flow("returning", "Books_on_Loan / loan_period", "books/week"),
            aux("borrowing fraction", 0.25, "1/week"),
            aux("loan period", 2, "weeks")
        ], { startTime: 0, stopTime: 52, dt: 0.125, timeUnits: "weeks" }, ["loan period->returning"]),
        adjustable: ["Books on Shelves", "Books on Loan"],
        frozen: "Keep the size of the collection (Books on Shelves + Books on Loan) at 12,000 books, and keep some books out on loan.",
        equilibriumStocks: ["Books on Shelves", "Books on Loan"],
        fixedTotal: { stocks: ["Books on Shelves", "Books on Loan"], total: 12000 },
        nonTrivial: { "Books on Loan": 1 },
        // lending = returning: 0.25 S = L / 2, so L = S / 2 and S + L = 12000
        solution: { "Books on Shelves": "8000", "Books on Loan": "4000" }
    },
    "Gym Members and Trainers": {
        group: "mediumEquilibrium",
        heldOut: true,
        description: "a gym whose members drift away when the floor gets crowded and which hires trainers to match its membership",
        model: model([
            stock("Members", 300, ["joining"], ["cancelling"], "members"),
            stock("Trainers", 10, ["trainer hiring"], [], "trainers"),
            flow("joining", "sign_ups", "members/month"),
            flow("cancelling", "Members / average_membership_length * crowding", "members/month"),
            flow("trainer hiring", "(desired_trainers - Trainers) / time_to_hire_trainers", "trainers/month"),
            aux("sign ups", 60, "members/month"),
            aux("average membership length", 12, "months"),
            aux("members per trainer", "Members / Trainers", "members/trainer"),
            aux("comfortable members per trainer", 50, "members/trainer"),
            aux("crowding", "members_per_trainer / comfortable_members_per_trainer", "dimensionless"),
            aux("staffing ratio", 40, "members/trainer"),
            aux("desired trainers", "Members / staffing_ratio", "trainers"),
            aux("time to hire trainers", 3, "months")
        ], { startTime: 0, stopTime: 60, dt: 0.125, timeUnits: "months" },
        ["average membership length->cancelling", "Trainers->members per trainer", "comfortable members per trainer->crowding", "staffing ratio->desired trainers", "Trainers->trainer hiring", "time to hire trainers->trainer hiring"]),
        adjustable: ["Members", "Trainers"],
        frozen: "Keep at least one trainer on staff.",
        equilibriumStocks: ["Members", "Trainers"],
        nonTrivial: { "Trainers": 1 },
        // T = M / 40 so crowding = 40 / 50; 60 = M / 12 * 0.8, so M = 900 and T = 22.5
        solution: { "Members": "900", "Trainers": "22.5" }
    },
    "City Road Repairs": {
        group: "complexEquilibrium",
        heldOut: true,
        description: "a city's roads wearing out and being resurfaced by crews it sizes to the repair backlog",
        model: model([
            stock("Good Roads", 600, ["resurfacing"], ["wearing out"], "km"),
            stock("Worn Roads", 0, ["wearing out"], ["resurfacing"], "km"),
            stock("Repair Crews", 4, ["crew change"], [], "crews"),
            flow("wearing out", "Good_Roads / road_surface_life", "km/year"),
            flow("resurfacing", "Repair_Crews * resurfacing_per_crew", "km/year"),
            flow("crew change", "(desired_crews - Repair_Crews) / time_to_adjust_crews", "crews/year"),
            aux("road surface life", 10, "years"),
            aux("resurfacing per crew", 5, "km/crews/year"),
            aux("target repair time", 2, "years"),
            aux("desired crews", "Worn_Roads / target_repair_time / resurfacing_per_crew", "crews"),
            aux("time to adjust crews", 1, "years")
        ], { startTime: 0, stopTime: 40, dt: 0.0625, timeUnits: "years" },
        ["road surface life->wearing out", "target repair time->desired crews", "resurfacing per crew->desired crews", "Repair Crews->crew change", "time to adjust crews->crew change"]),
        adjustable: ["Good Roads", "Worn Roads", "Repair Crews"],
        frozen: "Keep the city's total road length (Good Roads + Worn Roads) at 600 km, and keep the repair crews working.",
        equilibriumStocks: ["Good Roads", "Worn Roads", "Repair Crews"],
        fixedTotal: { stocks: ["Good Roads", "Worn Roads"], total: 600 },
        nonTrivial: { "Repair Crews": 1 },
        // G / 10 = W / 2 with G + W = 600; crews = W / 2 / 5
        solution: { "Good Roads": "500", "Worn Roads": "100", "Repair Crews": "10" }
    },
    "Water Utility": {
        group: "complexEquilibrium",
        heldOut: true,
        description: "a water utility that pumps river water into raw storage, treats it, and supplies customers from treated storage while its mains leak",
        model: model([
            stock("Raw Water Storage", 300, ["pumping"], ["treating"], "megaliters"),
            stock("Treated Water Storage", 200, ["treating"], ["customer use", "leakage"], "megaliters"),
            flow("pumping", "pumping_capacity", "megaliters/day"),
            flow("treating", "Raw_Water_Storage / treatment_time", "megaliters/day"),
            flow("customer use", "customer_demand", "megaliters/day"),
            flow("leakage", "Treated_Water_Storage * leak_fraction", "megaliters/day"),
            aux("pumping capacity", 50, "megaliters/day"),
            aux("treatment time", 2, "days"),
            aux("customer demand", 30, "megaliters/day"),
            aux("leak fraction", 0.05, "1/day")
        ], { startTime: 0, stopTime: 60, dt: 0.125, timeUnits: "days" }, ["treatment time->treating"]),
        adjustable: ["Raw Water Storage", "pumping capacity"],
        frozen: "Keep the initial Treated Water Storage at 200 megaliters.",
        equilibriumStocks: ["Raw Water Storage", "Treated Water Storage"],
        fixedInitial: { "Treated Water Storage": 200 },
        // treating = 30 + 200 * 0.05 = pumping; raw = treating * 2
        solution: { "Raw Water Storage": "80", "pumping capacity": "40" }
    },
    "Hotel Bookings": {
        group: "mediumEquilibrium",
        heldOut: true,
        description: "a hotel whose rooms pass from reservations to guests to housekeeping",
        model: model([
            stock("Reservations", 0, ["booking"], ["checking in", "cancelling"], "rooms"),
            stock("Occupied Rooms", 150, ["checking in"], ["checking out"], "rooms"),
            stock("Rooms Awaiting Cleaning", 0, ["checking out"], ["cleaning"], "rooms"),
            flow("booking", "booking_requests", "rooms/day"),
            flow("checking in", "Reservations / booking_lead_time", "rooms/day"),
            flow("cancelling", "Reservations * cancellation_fraction", "rooms/day"),
            flow("checking out", "Occupied_Rooms / length_of_stay", "rooms/day"),
            flow("cleaning", "Rooms_Awaiting_Cleaning / cleaning_time", "rooms/day"),
            aux("booking requests", 50, "rooms/day"),
            aux("booking lead time", 10, "days"),
            aux("cancellation fraction", 0.025, "1/day"),
            aux("length of stay", 2.5, "days"),
            aux("cleaning time", 0.25, "days")
        ], { startTime: 0, stopTime: 60, dt: 0.03125, timeUnits: "days" },
        ["booking lead time->checking in", "length of stay->checking out", "cleaning time->cleaning"]),
        adjustable: ["Reservations", "Occupied Rooms", "Rooms Awaiting Cleaning"],
        equilibriumStocks: ["Reservations", "Occupied Rooms", "Rooms Awaiting Cleaning"],
        // 50 = R * (0.1 + 0.025); check-ins 40/day; O = 40 * 2.5; awaiting = 40 * 0.25
        solution: { "Reservations": "400", "Occupied Rooms": "100", "Rooms Awaiting Cleaning": "10" }
    },
    "Packaging Recycling": {
        group: "complexEquilibrium",
        heldOut: true,
        description: "a town's packaging that is used, thrown into bins, and either landfilled or recycled into new packaging, topped up with new material",
        model: model([
            stock("Packaging in Use", 50, ["making from recycled material", "making from new material"], ["discarding"], "tonnes"),
            stock("Waste in Bins", 0, ["discarding"], ["recycling collection", "landfilling"], "tonnes"),
            stock("Recycled Stockpile", 0, ["recycling collection"], ["making from recycled material"], "tonnes"),
            flow("making from new material", "new_material_supply", "tonnes/month"),
            flow("making from recycled material", "Recycled_Stockpile / processing_time", "tonnes/month"),
            flow("discarding", "Packaging_in_Use / time_in_use", "tonnes/month"),
            flow("recycling collection", "Waste_in_Bins * recycling_share / collection_interval", "tonnes/month"),
            flow("landfilling", "Waste_in_Bins * (1 - recycling_share) / collection_interval", "tonnes/month"),
            aux("new material supply", 20, "tonnes/month"),
            aux("processing time", 1, "months"),
            aux("time in use", 2, "months"),
            aux("recycling share", 0.8, "dimensionless"),
            aux("collection interval", 0.5, "months")
        ], { startTime: 0, stopTime: 48, dt: 0.0625, timeUnits: "months" },
        ["processing time->making from recycled material", "time in use->discarding", "collection interval->recycling collection", "recycling share->landfilling", "collection interval->landfilling"]),
        adjustable: ["Packaging in Use", "Waste in Bins", "Recycled Stockpile"],
        equilibriumStocks: ["Packaging in Use", "Waste in Bins", "Recycled Stockpile"],
        nonTrivial: { "Packaging in Use": 1 },
        // landfilling 0.2 * W / 0.5 = 20, so W = 50; discarding = 100 so P = 200; recycled flow 80 so S = 80
        solution: { "Packaging in Use": "200", "Waste in Bins": "50", "Recycled Stockpile": "80" }
    },
    "Office Mugs": {
        group: "simpleEquilibrium",
        heldOut: true,
        description: "an office's mugs, which get used and left dirty, and washed up faster the bigger the pile gets",
        model: model([
            stock("Clean Mugs", 300, ["washing up"], ["using mugs"], "mugs"),
            stock("Dirty Mugs", 0, ["using mugs"], ["washing up"], "mugs"),
            flow("using mugs", "Clean_Mugs * use_fraction", "mugs/day"),
            flow("washing up", "Dirty_Mugs * washing_fraction * pile_pressure", "mugs/day"),
            aux("use fraction", 0.5, "1/day"),
            aux("washing fraction", 0.5, "1/day"),
            aux("pile pressure", "Dirty_Mugs / pile_people_notice", "dimensionless"),
            aux("pile people notice", 50, "mugs")
        ], { startTime: 0, stopTime: 30, dt: 0.0625, timeUnits: "days" }, ["pile people notice->pile pressure"]),
        adjustable: ["Clean Mugs", "Dirty Mugs"],
        frozen: "Keep the number of mugs in the office (Clean Mugs + Dirty Mugs) at 300.",
        equilibriumStocks: ["Clean Mugs", "Dirty Mugs"],
        fixedTotal: { stocks: ["Clean Mugs", "Dirty Mugs"], total: 300 },
        // using = washing: 0.5 C = 0.5 D * D / 50, so C = D^2 / 50; with C + D = 300, D = 100
        solution: { "Clean Mugs": "200", "Dirty Mugs": "100" }
    },
    "Running Club": {
        group: "mediumEquilibrium",
        heldOut: true,
        description: "a running club whose regulars bring in beginners, fewer as the keen people in town run out, and whose beginners either finish the beginner program or give up",
        model: model([
            stock("Beginners", 10, ["joining"], ["finishing the beginner program", "giving up"], "runners"),
            stock("Regular Runners", 200, ["finishing the beginner program"], ["drifting away"], "runners"),
            flow("joining", "Regular_Runners * invitations_per_runner * (1 - Regular_Runners / keen_residents)", "runners/month"),
            flow("finishing the beginner program", "Beginners / program_length", "runners/month"),
            flow("giving up", "Beginners * give_up_fraction", "runners/month"),
            flow("drifting away", "Regular_Runners / time_as_regular", "runners/month"),
            aux("invitations per runner", 0.5, "1/month"),
            aux("keen residents", 1000, "runners"),
            aux("program length", 2, "months"),
            aux("give up fraction", 0.25, "1/month"),
            aux("time as regular", 20, "months")
        ], { startTime: 0, stopTime: 60, dt: 0.0625, timeUnits: "months" },
        ["program length->finishing the beginner program", "time as regular->drifting away"]),
        adjustable: ["Beginners", "Regular Runners"],
        frozen: "Keep the club going: at least one beginner and at least one regular runner.",
        equilibriumStocks: ["Beginners", "Regular Runners"],
        nonTrivial: { "Beginners": 1, "Regular Runners": 1 },
        // two thirds of beginners finish (0.5 / 0.75); 2/3 * 0.5 * R * (1 - R / 1000) = R / 20 gives R = 850;
        // joining = 850 * 0.5 * 0.15 = 63.75 = B * 0.75, so B = 85
        solution: { "Beginners": "85", "Regular Runners": "850" }
    },
    "Appliance Repair Shop": {
        group: "complexEquilibrium",
        heldOut: true,
        description: "a repair shop where dropped-off appliances wait, are repaired on the bench and are tested, and those that fail the test go back on the bench",
        model: model([
            stock("Appliances Waiting", 60, ["dropping off"], ["starting repairs"], "appliances"),
            stock("Appliances on the Bench", 5, ["starting repairs", "failing the test"], ["finishing repairs"], "appliances"),
            stock("Appliances Being Tested", 0, ["finishing repairs"], ["passing the test", "failing the test"], "appliances"),
            flow("dropping off", "drop_offs", "appliances/week"),
            flow("starting repairs", "Appliances_Waiting / queue_time", "appliances/week"),
            flow("finishing repairs", "Appliances_on_the_Bench / repair_time", "appliances/week"),
            flow("passing the test", "Appliances_Being_Tested * pass_share / test_time", "appliances/week"),
            flow("failing the test", "Appliances_Being_Tested * (1 - pass_share) / test_time", "appliances/week"),
            aux("drop offs", 24, "appliances/week"),
            aux("queue time", 2, "weeks"),
            aux("repair time", 0.5, "weeks"),
            aux("pass share", 0.8, "dimensionless"),
            aux("test time", 0.25, "weeks")
        ], { startTime: 0, stopTime: 30, dt: 0.03125, timeUnits: "weeks" },
        ["queue time->starting repairs", "repair time->finishing repairs", "test time->passing the test", "pass share->failing the test", "test time->failing the test"]),
        adjustable: ["Appliances on the Bench", "Appliances Being Tested", "queue time"],
        frozen: "Keep the initial Appliances Waiting at 60.",
        equilibriumStocks: ["Appliances Waiting", "Appliances on the Bench", "Appliances Being Tested"],
        fixedInitial: { "Appliances Waiting": 60 },
        // passing = 24, so T = 24 * 0.25 / 0.8 = 7.5; finishing = T / 0.25 = 30, so bench = 15;
        // starting = 30 - 6 failed = 24 = 60 / queue time, so queue time = 2.5
        solution: { "Appliances on the Bench": "15", "Appliances Being Tested": "7.5", "queue time": "2.5" }
    }
};
