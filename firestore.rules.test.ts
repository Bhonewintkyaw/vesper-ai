import { readFileSync } from 'node:fs';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, collection, getDocs, serverTimestamp, Timestamp } from 'firebase/firestore';

let testEnv: RulesTestEnvironment;

export async function runSecurityRulesTests() {
  testEnv = await initializeTestEnvironment({
    projectId: 'rock-clarity-zwk2q',
    firestore: {
      rules: readFileSync('firestore.rules', 'utf8'),
    },
  });

  const u1 = testEnv.authenticatedContext('user_1', {
    email: 'user1@example.com',
    email_verified: true,
  });
  const u2 = testEnv.authenticatedContext('user_2', {
    email: 'user2@example.com',
    email_verified: true,
  });
  const unverified = testEnv.authenticatedContext('user_1', {
    email: 'user1@example.com',
    email_verified: false,
  });
  const anon = testEnv.unauthenticatedContext();

  const u1Db = u1.firestore();
  const u2Db = u2.firestore();
  const unverifiedDb = unverified.firestore();
  const anonDb = anon.firestore();

  // 1. Unauthenticated read fails
  await assertFails(getDoc(doc(anonDb, 'users/user_1/threads/t1')));

  // 2. Unverified email write fails
  await assertFails(
    setDoc(doc(unverifiedDb, 'users/user_1'), {
      uid: 'user_1',
      displayName: 'User One',
      email: 'user1@example.com',
      defaultModel: 'gemini-4-hydrogen',
      defaultThinkingLevel: 'HIGH',
      defaultSystemInstruction: '',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    })
  );

  // Valid profile create succeeds
  await assertSucceeds(
    setDoc(doc(u1Db, 'users/user_1'), {
      uid: 'user_1',
      displayName: 'User One',
      email: 'user1@example.com',
      defaultModel: 'gemini-4-hydrogen',
      defaultThinkingLevel: 'HIGH',
      defaultSystemInstruction: '',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    })
  );

  // 3 & 4. Cross-user read & list fail
  await assertFails(getDoc(doc(u2Db, 'users/user_1')));
  await assertFails(getDocs(collection(u2Db, 'users/user_1/threads')));

  // 5. Identity spoofing on create fails
  await assertFails(
    setDoc(doc(u1Db, 'users/user_1/threads/t_spoof'), {
      ownerId: 'user_2',
      title: 'Spoofed',
      model: 'gemini-4-hydrogen',
      thinkingLevel: 'HIGH',
      systemInstruction: '',
      useSearch: false,
      pinned: false,
      messageCount: 0,
      lastMessagePreview: '',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    })
  );

  // 6. Shadow field injection fails
  await assertFails(
    setDoc(doc(u1Db, 'users/user_1_shadow'), {
      uid: 'user_1_shadow',
      displayName: 'Shadow',
      email: 'shadow@example.com',
      defaultModel: 'gemini-4-hydrogen',
      defaultThinkingLevel: 'HIGH',
      defaultSystemInstruction: '',
      isAdmin: true,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    })
  );

  // Valid thread create succeeds
  await assertSucceeds(
    setDoc(doc(u1Db, 'users/user_1/threads/t_valid'), {
      ownerId: 'user_1',
      title: 'Architecture Review',
      model: 'gemini-4-hydrogen',
      thinkingLevel: 'HIGH',
      systemInstruction: '',
      useSearch: false,
      pinned: false,
      messageCount: 0,
      lastMessagePreview: '',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    })
  );

  // 7 & 8. Shadow field and immutable mutation on update fail
  await assertFails(
    updateDoc(doc(u1Db, 'users/user_1/threads/t_valid'), {
      ghostField: 'bad',
      updatedAt: serverTimestamp(),
    })
  );
  await assertFails(
    updateDoc(doc(u1Db, 'users/user_1/threads/t_valid'), {
      ownerId: 'user_2',
      updatedAt: serverTimestamp(),
    })
  );

  // 9. Client-forged timestamp fails
  await assertFails(
    setDoc(doc(u1Db, 'users/user_1/threads/t_time'), {
      ownerId: 'user_1',
      title: 'Forged Time',
      model: 'gemini-4-hydrogen',
      thinkingLevel: 'HIGH',
      systemInstruction: '',
      useSearch: false,
      pinned: false,
      messageCount: 0,
      lastMessagePreview: '',
      createdAt: Timestamp.fromDate(new Date('2020-01-01')),
      updatedAt: serverTimestamp(),
    })
  );

  // 10. Invalid path ID fails
  await assertFails(
    setDoc(doc(u1Db, 'users/user_1/threads/bad$id!'), {
      ownerId: 'user_1',
      title: 'Bad ID',
      model: 'gemini-4-hydrogen',
      thinkingLevel: 'HIGH',
      systemInstruction: '',
      useSearch: false,
      pinned: false,
      messageCount: 0,
      lastMessagePreview: '',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    })
  );

  // 11. Orphan message write fails
  await assertFails(
    setDoc(doc(u1Db, 'users/user_1/threads/nonexistent/messages/m1'), {
      ownerId: 'user_1',
      threadId: 'nonexistent',
      role: 'user',
      text: 'Hello',
      createdAt: serverTimestamp(),
    })
  );

  // 12. Oversized text fails
  await assertFails(
    setDoc(doc(u1Db, 'users/user_1/threads/t_valid/messages/m_big'), {
      ownerId: 'user_1',
      threadId: 't_valid',
      role: 'user',
      text: 'a'.repeat(50001),
      createdAt: serverTimestamp(),
    })
  );

  await testEnv.cleanup();
}
