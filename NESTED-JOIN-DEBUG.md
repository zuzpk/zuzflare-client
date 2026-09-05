# Nested Join Debugging Guide

## Issue Summary
Nested joins (via `joinNested`) are returning empty results for `fields` even though:
- The query structure is correct
- Data exists in both collections
- Field mappings are correct (`modules.id` → `module_fields.sectionId`)

## Query Being Sent (Verified ✅)
```json
{
  "collection": "webs",
  "query": {
    "where": [{"field": "_id", "op": "==", "value": "fLPNbTvjFNKpauQ1S-"}],
    "joins": [
      {
        "from": "webs_configs",
        "localField": "_id",
        "foreignField": "appId",
        "as": "conf"
      },
      {
        "from": "modules",
        "localField": "_id",
        "foreignField": "appId",
        "as": "mods",
        "joins": [
          {
            "from": "module_fields",
            "localField": "_id",
            "foreignField": "sectionId",
            "as": "fields"
          }
        ]
      }
    ]
  }
}
```

This structure is **CORRECT**.

## Server-Side Checklist

Since the client is sending the correct query, the issue is on the server side. Check:

### 1. ✅ Data Exists
- Module with `_id: "APhX4tj2opw8jAUKqO"` exists
- ModuleFields with `sectionId: "APhX4tj2opw8jAUKqO"` exists

### 2. ❓ Server Join Implementation
Check your server code for nested join handling:

#### MongoDB Aggregation Pipeline
The server should generate something like:
```javascript
[
  { $match: { _id: "fLPNbTvjFNKpauQ1S-" } },
  {
    $lookup: {
      from: "modules",
      localField: "_id",
      foreignField: "appId",
      as: "mods"
    }
  },
  {
    $lookup: {
      from: "webs_configs",
      localField: "_id",
      foreignField: "appId",
      as: "conf"
    }
  },
  // NESTED JOIN - This is the critical part
  {
    $addFields: {
      mods: {
        $map: {
          input: "$mods",
          as: "mod",
          in: {
            $mergeObjects: [
              "$$mod",
              {
                fields: {
                  $filter: {
                    input: "$module_fields",  // ← This needs to be populated first
                    as: "field",
                    cond: { $eq: ["$$field.sectionId", "$$mod._id"] }
                  }
                }
              }
            ]
          }
        }
      }
    }
  }
]
```

### 3. Common Server-Side Issues

#### Issue A: Missing Nested $lookup
The server needs to:
1. Perform `$lookup` for `module_fields` 
2. Store results in a temporary field
3. Then map/filter for each parent document

#### Issue B: Field Name Mismatch
- Client normalizes `id` → `_id` 
- Server might be using wrong field names in nested joins

#### Issue C: Nested Joins Not Implemented
Some implementations only support one level of joins.

## Quick Tests to Run

### Test 1: Verify Direct Join Works
```typescript
// This SHOULD work
const modulesWithFields = await flare.collection('modules')
    .where({ appId })
    .join('module_fields', {
        source: 'id',
        target: 'sectionId',
        as: 'fields'
    })
    .get();
```
**Expected**: Modules with populated `fields` array

### Test 2: Verify Nested Join Structure
```typescript
const query = flare.collection('webs')
    .where({ id: appId })
    .join('modules', {
        source: 'id',
        target: 'appId',
        as: 'mods'
    })
    .joinNested('mods', 'module_fields', {
        source: 'id',
        target: 'sectionId',
        as: 'fields'
    });

console.log(query.getRawQuery());
```
**Expected**: Correct structure with nested joins array

## Server-Side Fix

If nested joins aren't working on the server, you have two options:

### Option 1: Server-Side Implementation
Implement recursive nested joins in your query processor.

### Option 2: Client-Side Hydration (Workaround)
Fetch data separately and join client-side:

```typescript
async function getAppWithModulesAndFields(appId: string) {
    // Step 1: Get app
    const app = await flare.collection('webs')
        .where({ id: appId })
        .get();
    
    // Step 2: Get modules
    const modules = await flare.collection('modules')
        .where({ appId })
        .get();
    
    // Step 3: Get all module fields in one query
    const moduleIds = modules.map(m => m.id);
    const allFields = await flare.collection('module_fields')
        .where({ sectionId: { in: moduleIds } })  // If 'in' operator is supported
        .get();
    // OR individual queries:
    // for (const mod of modules) {
    //     mod.fields = await flare.collection('module_fields')
    //         .where({ sectionId: mod.id })
    //         .get();
    // }
    
    // Step 4: Merge data
    const fieldsByModule = new Map();
    allFields.forEach(field => {
        if (!fieldsByModule.has(field.sectionId)) {
            fieldsByModule.set(field.sectionId, []);
        }
        fieldsByModule.get(field.sectionId).push(field);
    });
    
    modules.forEach(mod => {
        mod.fields = fieldsByModule.get(mod.id) || [];
    });
    
    return { ...app[0], mods: modules };
}
```

## Next Steps

1. **Check your server logs** - See if the nested join query is being received
2. **Check server implementation** - Verify nested joins are supported
3. **Run the debug script** - Use `server-join-debug.ts` to isolate the issue
4. **Contact server team** - If nested joins aren't implemented, they need to add support

## Verification

Run the debug script:
```bash
npx tsx server-join-debug.ts
```

This will tell you exactly where the join is failing.
