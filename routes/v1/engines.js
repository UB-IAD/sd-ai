import express from 'express'
import fs from 'fs'
import config from '../../config.js'

const router = express.Router()
const quantitativeEngines = ['quantitative'];

// supportedModes() depends only on what is installed on the host (python packages, docker images),
// which cannot change while this process runs. Some engines answer it with a blocking spawnSync
// (causal-decoder imports torch: ~4 s of CPU), so compute it once per engine per process.
const supportedModesCache = new Map();

function listEngineDirs() {
    const path = "engines"
    let dirs = fs.readdirSync(path).filter(f => fs.lstatSync(`${path}/${f}`).isDirectory());
    if (!config.includeTestEngines) {
        dirs = dirs.filter(f => !f.startsWith('test-'));
    }
    return dirs;
}

function cachedSupportedModes(dir, engine) {
    if (!supportedModesCache.has(dir)) {
        supportedModesCache.set(dir, engine.default.supportedModes());
    }
    return supportedModesCache.get(dir);
}

// Called once at server startup, before listen, so the first client request doesn't pay the cost.
export async function warmEngineCache() {
    for (const dir of listEngineDirs()) {
        const engine = await import(`./../../engines/${dir}/engine.js`);
        cachedSupportedModes(dir, engine);
    }
}

router.get("/", async (req, res) => {
    const dirs = listEngineDirs();

    const engines = [];
    for (const dir of dirs) {
        const engine = await import(`./../../engines/${dir}/engine.js`);
        const supportedModes = cachedSupportedModes(dir, engine);
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
            "ltm-discuss": "ltm-narrative",
            "documentation": "generate-documentation"
        }
    });
})

export default router;