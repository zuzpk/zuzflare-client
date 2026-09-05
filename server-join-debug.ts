/**
 * Debug: Test different join configurations
 * Run this to isolate where the issue is
 */

import { FlareClient } from './src/index';
import type { CollectionReference } from './src/Query';

async function debugJoinIssue() {
    const flare = new FlareClient({
        endpoint: 'http://localhost:5050',
        appId: 'default',
        debug: true
    });

    const Collections = {
        Apps: 'webs',
        AppsConfigs: 'webs_configs',
        Modules: 'modules',
        ModuleFields: 'module_fields'
    };

    const appId = 'fLPNbTvjFNKpauQ1S-';

    console.log('\n🔍 Debugging Nested Join Issue\n');

    // TEST 1: Direct query on module_fields to verify data exists
    console.log('═══════════════════════════════════════════════════════');
    console.log('TEST 1: Direct query on module_fields collection');
    console.log('═══════════════════════════════════════════════════════');
    
    const moduleFields = await flare.collection(Collections.ModuleFields)
        .limit(5)
        .get();
    
    console.log(`Total module_fields: ${moduleFields.length}`);
    if (moduleFields.length > 0) {
        console.log('Sample field:', {
            id: moduleFields[0].id,
            name: moduleFields[0].name,
            sectionId: moduleFields[0].sectionId
        });
    }
    console.log('');

    // TEST 2: Get one module and check its fields manually
    console.log('═══════════════════════════════════════════════════════');
    console.log('TEST 2: Manual field lookup for a specific module');
    console.log('═══════════════════════════════════════════════════════');
    
    const modules = await flare.collection(Collections.Modules)
        .where({ appId })
        .limit(1)
        .get();
    
    if (modules.length > 0) {
        const moduleId = modules[0].id;
        console.log(`Module ID: ${moduleId}`);
        console.log(`Module Name: ${modules[0].name}`);
        
        const fieldsForModule = await flare.collection(Collections.ModuleFields)
            .where({ sectionId: moduleId })
            .get();
        
        console.log(`Fields for module "${modules[0].name}": ${fieldsForModule.length}`);
        console.log('');
    }

    // TEST 3: Try joining modules directly with module_fields (no nesting)
    console.log('═══════════════════════════════════════════════════════');
    console.log('TEST 3: Simple join modules -> module_fields (no nesting)');
    console.log('═══════════════════════════════════════════════════════');
    
    const modulesWithFields = await flare.collection(Collections.Modules)
        .where({ appId })
        .join(Collections.ModuleFields, {
            source: 'id',
            target: 'sectionId',
            as: 'fields'
        })
        .get();
    
    console.log(`Modules returned: ${modulesWithFields.length}`);
    if (modulesWithFields.length > 0) {
        console.log(`First module has ${modulesWithFields[0].fields?.length || 0} fields`);
        console.log('Sample:', {
            moduleId: modulesWithFields[0].id,
            moduleName: modulesWithFields[0].name,
            fieldsCount: modulesWithFields[0].fields?.length || 0
        });
    }
    console.log('');

    // TEST 4: Apps with modules join (baseline)
    console.log('═══════════════════════════════════════════════════════');
    console.log('TEST 4: Apps -> Modules join (no nesting)');
    console.log('═══════════════════════════════════════════════════════');
    
    const appsWithMods = await flare.collection(Collections.Apps)
        .where({ id: appId })
        .join(Collections.Modules, {
            source: 'id',
            target: 'appId',
            as: 'mods'
        })
        .get();
    
    console.log(`Apps returned: ${appsWithMods.length}`);
    if (appsWithMods.length > 0 && appsWithMods[0].mods?.length > 0) {
        console.log(`First app has ${appsWithMods[0].mods.length} modules`);
    }
    console.log('');

    // TEST 5: Apps -> Modules -> ModuleFields (nested join)
    console.log('═══════════════════════════════════════════════════════');
    console.log('TEST 5: Apps -> Modules -> ModuleFields (nested join)');
    console.log('═══════════════════════════════════════════════════════');
    
    const appsWithNested = await flare.collection(Collections.Apps)
        .where({ id: appId })
        .join(Collections.Modules, {
            source: 'id',
            target: 'appId',
            as: 'mods'
        })
        .joinNested('mods', Collections.ModuleFields, {
            source: 'id',
            target: 'sectionId',
            as: 'fields'
        })
        .get();
    
    console.log(`Apps returned: ${appsWithNested.length}`);
    if (appsWithNested.length > 0) {
        console.log(`First app has ${appsWithNested[0].mods?.length || 0} modules`);
        if (appsWithNested[0].mods?.length > 0) {
            const firstMod = appsWithNested[0].mods[0];
            console.log(`First module "${firstMod.name}" has ${firstMod.fields?.length || 0} fields`);
            
            if (firstMod.fields && firstMod.fields.length > 0) {
                console.log('✅ Fields ARE being joined!');
            } else {
                console.log('❌ Fields are EMPTY - nested join not working');
            }
        }
    }
    console.log('');

    // TEST 6: Alternative - Inline nested join syntax
    console.log('═══════════════════════════════════════════════════════');
    console.log('TEST 6: Alternative inline nested join syntax');
    console.log('═══════════════════════════════════════════════════════');
    
    const appsWithInline = await flare.collection(Collections.Apps)
        .where({ id: appId })
        .join(Collections.Modules, {
            source: 'id',
            target: 'appId',
            as: 'mods',
            joins: [{
                collection: Collections.ModuleFields,
                source: 'id',
                target: 'sectionId',
                as: 'fields'
            }]
        })
        .get();
    
    console.log(`Apps returned: ${appsWithInline.length}`);
    if (appsWithInline.length > 0 && appsWithInline[0].mods?.length > 0) {
        const firstMod = appsWithInline[0].mods[0];
        console.log(`First module has ${firstMod.fields?.length || 0} fields (inline syntax)`);
    }
    console.log('');

    // TEST 7: Check the raw query structure
    console.log('═══════════════════════════════════════════════════════');
    console.log('TEST 7: Raw query structure inspection');
    console.log('═══════════════════════════════════════════════════════');
    
    const query = flare.collection(Collections.Apps)
        .where({ id: appId })
        .join(Collections.Modules, {
            source: 'id',
            target: 'appId',
            as: 'mods'
        })
        .joinNested('mods', Collections.ModuleFields, {
            source: 'id',
            target: 'sectionId',
            as: 'fields'
        });
    
    const rawQuery = (query as any).getRawQuery();
    console.log('Raw query structure:');
    console.log(JSON.stringify(rawQuery, null, 2));
    console.log('');

    flare.disconnect();
    
    console.log('\n📋 Summary:');
    console.log('If TEST 3 works but TEST 5 doesn\'t, the issue is with nested joins on the server side.');
    console.log('If TEST 3 also fails, the issue is with the join field mapping.');
}

debugJoinIssue().catch(console.error);
