#!/usr/bin/env node

/**
 * Join and Nested Join Examples for @zuzjs/flare-client
 * 
 * This file demonstrates:
 * 1. Simple join between two collections
 * 2. Multiple joins on a single query
 * 3. Nested joins (join within a join)
 * 4. SQL-like relation shorthand withRelation()
 * 5. Combining joins with filters, limits, and ordering
 */

import { FlareClient } from './src/index';

async function runJoinExamples() {
    console.log('\n🔗 ZuzFlare Join Examples\n');

    // ===== 1. Initialize Client =====
    console.log('📌 1. Initializing Client...');
    const flare = new FlareClient({
        endpoint: 'http://localhost:5050',
        appId: 'default',
        debug: true,
        autoReconnect: true
    });

    flare.connect();
    await new Promise(resolve => setTimeout(resolve, 1000));

    // ===== 2. Setup Test Data =====
    console.log('\n📌 2. Creating Test Data...');

    // Users
    await flare.collection('users').doc('alice').set({
        name: 'Alice Johnson',
        email: 'alice@example.com',
        role: 'admin'
    });

    await flare.collection('users').doc('bob').set({
        name: 'Bob Smith',
        email: 'bob@example.com',
        role: 'developer'
    });

    // Teams
    await flare.collection('teams').doc('team-1').set({
        name: 'Engineering',
        uid: 'alice',  // team lead
        members: ['alice', 'bob']
    });

    // Boards
    await flare.collection('boards').doc('board-1').set({
        title: 'Project Alpha',
        team: { uid: 'alice' },
        createdBy: 'alice'
    });

    // Lists
    await flare.collection('lists').doc('list-1').set({
        title: 'To Do',
        boardId: 'board-1',
        order: 1
    });

    await flare.collection('lists').doc('list-2').set({
        title: 'In Progress',
        boardId: 'board-1',
        order: 2
    });

    // Cards
    await flare.collection('cards').doc('card-1').set({
        title: 'Implement feature X',
        listId: 'list-1',
        assigneeId: 'bob',
        priority: 'high'
    });

    await flare.collection('cards').doc('card-2').set({
        title: 'Review PR',
        listId: 'list-2',
        assigneeId: 'alice',
        priority: 'medium'
    });

    // Comments
    await flare.collection('comments').doc('comment-1').set({
        text: 'Looks good!',
        cardId: 'card-1',
        authorId: 'alice',
        createdAt: Date.now()
    });

    await new Promise(resolve => setTimeout(resolve, 500));

    // ===== EXAMPLE 1: Simple Join =====
    console.log('\n📌 3. Simple Join: Boards with Lists');
    console.log('   └─ Joining boards -> lists where board.id matches list.boardId');

    const boardsWithLists = await flare.collection('boards')
        .join('lists', {
            source: 'id',        // board.id
            target: 'boardId',  // list.boardId
            as: 'lists'         // alias for joined data
        })
        .get();

    console.log('   Result:', JSON.stringify(boardsWithLists, null, 2));

    // ===== EXAMPLE 2: Multiple Joins =====
    console.log('\n📌 4. Multiple Joins: Boards with Lists AND Team Members');
    console.log('   └─ Joining boards -> lists');
    console.log('   └─ Joining boards -> users (via nested team.uid path)');

    const boardsWithListsAndMembers = await flare.collection('boards')
        .join('lists', {
            source: 'id',
            target: 'boardId',
            as: 'lists'
        })
        .join('users', {
            source: 'team.uid',   // nested path in board document
            target: 'id',         // user.id
            as: 'teamMembers'     // alias for joined user data
        })
        .get();

    console.log('   Result:', JSON.stringify(boardsWithListsAndMembers, null, 2));

    // ===== EXAMPLE 3: Nested Joins (Three-Level Deep) =====
    console.log('\n📌 5. Nested Joins: Boards -> Lists -> Cards -> Comments');
    console.log('   └─ Each level builds on the previous join');

    const boardWithNestedData = await flare.collection('boards')
        // First join: boards -> lists
        .join('lists', {
            source: 'id',
            target: 'boardId',
            as: 'lists'
        })
        // Nested join: lists -> cards (under 'lists' alias)
        .joinNested('lists', 'cards', {
            source: 'id',
            target: 'listId',
            as: 'cards'
        })
        // Nested join: cards -> comments (under 'cards' alias)
        .joinNested('cards', 'comments', {
            source: 'id',
            target: 'cardId',
            as: 'comments'
        })
        .get();

    console.log('   Result:', JSON.stringify(boardWithNestedData, null, 2));

    // ===== EXAMPLE 4: Join with Filters =====
    console.log('\n📌 6. Join with Filters and Limits');

    const filteredBoards = await flare.collection('boards')
        .where({ createdBy: 'alice' })
        .join('lists', {
            source: 'id',
            target: 'boardId',
            as: 'lists',
            where: [{ field: 'order', op: '==', value: 1 }],  // Filter on joined collection
            limit: 5,
            orderBy: [{ field: 'order', dir: 'asc' }]
        })
        .get();

    console.log('   Result:', JSON.stringify(filteredBoards, null, 2));

    // ===== EXAMPLE 5: Join with Aggregation =====
    console.log('\n📌 7. Join with Aggregation');

    const boardsWithListCount = await flare.collection('boards')
        .join('lists', {
            source: 'id',
            target: 'boardId',
            as: 'listStats',
            aggregate: [{ fn: 'count', alias: 'totalLists' }],  // Count lists per board
            groupBy: { fields: ['boardId'] }
        })
        .get();

    console.log('   Result:', JSON.stringify(boardsWithListCount, null, 2));

    // ===== EXAMPLE 6: SQL-like Relation Shorthand =====
    console.log('\n📌 8. Relation Shorthand with withRelation()');
    console.log('   └─ Syntax: "sourceField->targetCollection.targetField"');

    const boardsWithShorthand = await flare.collection('boards')
        .where({ id: 'board-1' })
        // Shorthand: team.uid (in board) -> users.id (in users collection)
        .withRelation('team.uid->users.id', {
            as: 'teamLead',
            limit: 1,
            select: ['id', 'name', 'email']  // Only select specific fields
        })
        .get();

    console.log('   Result:', JSON.stringify(boardsWithShorthand, null, 2));

    // Alternative inline alias syntax
    console.log('\n📌 9. Relation Shorthand with Inline Alias');

    const boardsWithInlineAlias = await flare.collection('boards')
        .withRelation('team.uid->users.id as teamLead')
        .get();

    console.log('   Result:', JSON.stringify(boardsWithInlineAlias, null, 2));

    // ===== EXAMPLE 7: Single-Object Join =====
    console.log('\n📌 10. Single-Object Join (one-to-one)');

    const boardsWithSingleUser = await flare.collection('boards')
        .join('users', {
            source: 'createdBy',
            target: 'id',
            as: 'creator',
            single: true  // Returns object instead of array
        })
        .get();

    console.log('   Result:', JSON.stringify(boardsWithSingleUser, null, 2));

    // ===== EXAMPLE 8: Complete Example - Task Board Dashboard =====
    console.log('\n📌 11. Complete Example: Task Board Dashboard');

    const dashboardData = await flare.collection('boards')
        .where({ createdBy: 'alice' })
        .latest()
        .limit(10)
        .join('lists', {
            source: 'id',
            target: 'boardId',
            as: 'lists',
            orderBy: [{ field: 'order', dir: 'asc' }],
            joins: [{
                collection: 'cards',
                source: 'id',
                target: 'listId',
                as: 'cards',
                joins: [{
                    collection: 'comments',
                    source: 'id',
                    target: 'cardId',
                    as: 'comments',
                    limit: 5
                }]
            }]
        })
        .join('users', {
            source: 'createdBy',
            target: 'id',
            as: 'creator',
            single: true,
            select: ['id', 'name', 'email']
        })
        .get();

    console.log('   Dashboard data:', JSON.stringify(dashboardData, null, 2));

    // ===== Cleanup =====
    console.log('\n📌 12. Cleaning up test data...');

    await flare.collection('comments').doc('comment-1').delete();
    await flare.collection('cards').doc('card-1').delete();
    await flare.collection('cards').doc('card-2').delete();
    await flare.collection('lists').doc('list-1').delete();
    await flare.collection('lists').doc('list-2').delete();
    await flare.collection('boards').doc('board-1').delete();
    await flare.collection('teams').doc('team-1').delete();
    await flare.collection('users').doc('alice').delete();
    await flare.collection('users').doc('bob').delete();

    console.log('   ✓ Test data cleaned up');

    // Disconnect
    flare.disconnect();

    console.log('\n✅ All join examples completed!\n');
    console.log('📚 Key API Methods:');
    console.log('   • .join(collection, { source, target, as, ...options })');
    console.log('   • .joinNested(parentAlias, collection, { source, target, as, ...options })');
    console.log('   • .withRelation("sourceField->targetCollection.targetField", options)');
    console.log('   • Options: where, orderBy, limit, offset, aggregate, groupBy, single, select');
    console.log('');
}

// Run examples
runJoinExamples().catch(console.error);
