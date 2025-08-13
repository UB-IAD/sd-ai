import express from 'express'
import fs from 'fs'

const router = express.Router()
const quantitativeEngines = ['quantitative'];

router.get("/", async (req, res) => {
    const path = "engines"
    const dirs = fs.readdirSync(path).filter(f => fs.lstatSync(`${path}/${f}`).isDirectory());

    const engines = [];
    for (const dir of dirs) {
        const engine = await import(`./../../engines/${dir}/engine.js`);
        const supportedModes = engine.default.supportedModes();
        if (supportedModes && supportedModes.length > 0) {
            let description = null;
            try {
                description = engine.default.description ? engine.default.description() : null;
            } catch (e) {
                // If description method doesn't exist or fails, description stays null
            }
            
            let link = null;
            try {
                link = engine.default.link ? engine.default.link() : null;
            } catch (e) {
                // If link method doesn't exist or fails, link stays null
            }
            
            const engineData = {
                name: dir,
                supports: supportedModes,
                description: description,
                source: `https://github.com/UB-IAD/sd-ai/tree/main/engines/${dir}`,
            };
            
            // Only include link if it exists
            if (link) {
                engineData.link = link;
            }
            
            engines.push(engineData);
        }
    }
    
    //sort them so that qualitative comes first for old stella clients!
    const qualIndex = engines.findIndex((engine) => {
        return engine.name === 'qualitative';
    });
    
    // Sort alphabetically with experimental engines at the bottom
    engines.sort((a, b) => {
        const aIsExperimental = a.name.endsWith('-experimental');
        const bIsExperimental = b.name.endsWith('-experimental');
        
        // If one is experimental and the other isn't, experimental goes to bottom
        if (aIsExperimental && !bIsExperimental) return 1;
        if (!aIsExperimental && bIsExperimental) return -1;
        
        // If both are experimental or both are not experimental, sort alphabetically
        return a.name.localeCompare(b.name);
    });

    if (qualIndex >= 0) {
        let qualEngine = engines.splice(qualIndex, 1)[0];
        engines.unshift(qualEngine);
    }
    
    return res.send({
        success: true, 
        engines: engines,
        recommendedDefaults: {
            "sfd": "quantitative",
            "cld": "qualitative",
            "sfd-discuss": "seldon",
            "cld-discuss": "seldon",
            "ltm-discuss": "ltm-narrative"
        }
    });
})

export default router;