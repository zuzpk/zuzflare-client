/**
 * Test to verify nested join behavior
 * 
 * This script helps debug why module_fields are not being joined
 */

import { FlareClient } from './src/index';

async function testNestedJoin() {
    const flare = new FlareClient({
        endpoint: 'http://localhost:5050',
        appId: 'default',
        debug: true  // Enable debug mode to see queries
    });

    const Collections = {
        Apps: 'webs',
        AppsConfigs: 'webs_configs',
        Modules: 'modules',
        ModuleFields: 'module_fields'
    };

    const appId = 'fLPNbTvjFNKpauQ1S-';

    console.log('\n🧪 Testing Nested Join\n');

    // Test 1: Check if modules exist
    console.log('📋 Test 1: Fetch modules for app');
    const modules = await flare.collection(Collections.Modules)
        .where({ appId: appId })
        .get();
    console.log(`Found ${modules.length} modules:`, modules.map(m => ({ id: m._id || m.id, name: m.name })));

    // Test 2: Check if module_fields exist
    console.log('\n📋 Test 2: Fetch module_fields for each module');
    for (const mod of modules) {
        const modId = mod._id || mod.id;
        const fields = await flare.collection(Collections.ModuleFields)
            .where({ sectionId: modId })
            .get();
        console.log(`Module "${mod.name}" (${modId}): ${fields.length} fields`);
        if (fields.length > 0) {
            console.log('  Fields:', fields.map(f => ({ id: f._id || f.id, name: f.name, sectionId: f.sectionId })));
        }
    }

    // Test 3: Try the join WITHOUT nesting first
    console.log('\n📋 Test 3: Simple join (apps + modules)');
    const simpleJoin = await flare.collection(Collections.Apps)
        .where({ _id: appId })
        .join(Collections.Modules, {
            source: '_id',
            target: 'appId',
            as: 'mods'
        })
        .get();
    console.log('Simple join result:', JSON.stringify(simpleJoin, null, 2));

    // Test 4: Now with nested join
    console.log('\n📋 Test 4: Nested join (apps + modules + module_fields)');
    const nestedJoin = await flare.collection(Collections.Apps)
        .where({ _id: appId })
        .join(Collections.Modules, {
            source: '_id',
            target: 'appId',
            as: 'mods'
        })
        .joinNested('mods', Collections.ModuleFields, {
            source: '_id',
            target: 'sectionId',
            as: 'fields'
        })
        .get();
    console.log('Nested join result:', JSON.stringify(nestedJoin, null, 2));

    // Test 5: Try with explicit field mapping using dot notation
    console.log('\n📋 Test 5: Alternative - Join modules directly on module_fields');
    const alternativeNested = await flare.collection(Collections.Modules)
        .where({ appId: appId })
        .join(Collections.ModuleFields, {
            source: '_id',
            target: 'sectionId',
            as: 'fields'
        })
        .get();
    console.log('Alternative nested result:', JSON.stringify(alternativeNested, null, 2));

    flare.disconnect();
}

testNestedJoin().catch(console.error);
