import {
  collection,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
} from "firebase/firestore/lite";
import { firestore } from "./firebase";

export const DEFAULT_ORG_ID = "afterschoolpay";

export const DEFAULT_BRANCHES = [
  {
    id: "school-1",
    name: "一校",
    shortName: "一",
    status: "active",
    sortOrder: 1,
  },
  {
    id: "school-2",
    name: "二校",
    shortName: "二",
    status: "active",
    sortOrder: 2,
  },
  {
    id: "school-3",
    name: "三校",
    shortName: "三",
    status: "active",
    sortOrder: 3,
  },
];

const DEFAULT_PROGRAMS = [
  {
    id: "elementary-core",
    name: "國小課後班",
    subjects: ["安親", "英文", "數學", "美術", "圍棋"],
    status: "active",
    sortOrder: 1,
  },
  {
    id: "middle-school-core",
    name: "國中課後班",
    subjects: ["英文", "數學", "理化"],
    status: "active",
    sortOrder: 2,
  },
];

const OWNER_PERMISSIONS = {
  canManageOrganization: true,
  canManageMembers: true,
  canRecordDailyLedger: true,
  canTransferBetweenBranches: true,
  canViewAllBranches: true,
  canViewPayroll: true,
  canViewStudents: true,
};

const PENDING_PERMISSIONS = {
  canManageOrganization: false,
  canManageMembers: false,
  canRecordDailyLedger: false,
  canTransferBetweenBranches: false,
  canViewAllBranches: false,
  canViewPayroll: false,
  canViewStudents: false,
};

const ROLE_LABELS = {
  1: "等級 1：負責人",
  2: "等級 2：分校主管",
  3: "等級 3：行政人員",
  4: "等級 4：等待開通",
};

const normalizeEmail = (email) => (email || "").trim().toLowerCase();

const getBootstrapOwnerEmails = () =>
  [
    import.meta.env.VITE_BOOTSTRAP_OWNER_EMAIL,
    import.meta.env.VITE_BOOTSTRAP_OWNER_EMAILS,
  ]
    .filter(Boolean)
    .flatMap((value) => value.split(","))
    .map(normalizeEmail)
    .filter(Boolean);

const isBootstrapOwner = (email) =>
  getBootstrapOwnerEmails().includes(normalizeEmail(email));

const requireFirestore = () => {
  if (!firestore) {
    throw new Error(
      "Firebase 尚未設定完成。請先加入 VITE_FB_* 設定值，再載入管理後台。",
    );
  }

  return firestore;
};

const sortByOrder = (items) =>
  [...items].sort((first, second) => {
    const firstOrder = first.sortOrder ?? 0;
    const secondOrder = second.sortOrder ?? 0;

    if (firstOrder !== secondOrder) {
      return firstOrder - secondOrder;
    }

    return first.name.localeCompare(second.name);
  });

async function setIfMissing(ref, data) {
  const snapshot = await getDoc(ref);

  if (snapshot.exists()) {
    return {
      id: ref.id,
      ...snapshot.data(),
    };
  }

  const createData = {
    ...data,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  await setDoc(ref, createData);

  return {
    id: ref.id,
    ...data,
  };
}

async function listSubcollection(path) {
  const db = requireFirestore();
  const snapshot = await getDocs(collection(db, ...path));
  const records = snapshot.docs.map((record) => ({
    id: record.id,
    ...record.data(),
  }));

  return sortByOrder(records);
}

export function getRoleLevelLabel(level) {
  return ROLE_LABELS[level] || "自訂權限";
}

function canSeedOrganization(member) {
  return member.roleLevel === 1 || member.permissions?.canManageOrganization;
}

export async function ensureUserProfile(user) {
  const db = requireFirestore();
  const profileRef = doc(db, "users", user.uid);
  const profileSnapshot = await getDoc(profileRef);
  const existingProfile = profileSnapshot.exists() ? profileSnapshot.data() : {};
  const orgIds = new Set(existingProfile.orgIds || []);
  orgIds.add(DEFAULT_ORG_ID);

  const baseProfile = {
    uid: user.uid,
    email: normalizeEmail(user.email),
    displayName: user.displayName || "",
    photoURL: user.photoURL || "",
    activeOrgId: existingProfile.activeOrgId || DEFAULT_ORG_ID,
    orgIds: Array.from(orgIds),
    lastLoginAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  if (!profileSnapshot.exists()) {
    await setDoc(profileRef, {
      ...baseProfile,
      createdAt: serverTimestamp(),
    });

    return {
      ...baseProfile,
      createdAt: null,
      lastLoginAt: null,
      updatedAt: null,
    };
  }

  await setDoc(profileRef, baseProfile, { merge: true });

  return {
    ...existingProfile,
    ...baseProfile,
    lastLoginAt: existingProfile.lastLoginAt || null,
    updatedAt: existingProfile.updatedAt || null,
  };
}

export async function ensureDefaultOrganization(member) {
  const db = requireFirestore();
  const organizationRef = doc(db, "organizations", DEFAULT_ORG_ID);
  const organizationSnapshot = await getDoc(organizationRef);
  const seedAllowed = canSeedOrganization(member);
  let organization;

  if (organizationSnapshot.exists()) {
    organization = {
      id: organizationRef.id,
      ...organizationSnapshot.data(),
    };
  } else {
    if (!seedAllowed) {
      throw new Error("組織尚未建立。");
    }

    const organizationData = {
      name: "Afterschool Pay",
      slug: "afterschoolpay",
      status: "active",
      timezone: "Asia/Taipei",
      plan: "prototype",
    };

    await setDoc(organizationRef, {
      ...organizationData,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    organization = {
      id: organizationRef.id,
      ...organizationData,
    };
  }

  if (!seedAllowed) {
    return organization;
  }

  await Promise.all(
    DEFAULT_BRANCHES.map((branch) =>
      setIfMissing(
        doc(db, "organizations", DEFAULT_ORG_ID, "branches", branch.id),
        branch,
      ),
    ),
  );

  await Promise.all(
    DEFAULT_PROGRAMS.map((program) =>
      setIfMissing(
        doc(db, "organizations", DEFAULT_ORG_ID, "programs", program.id),
        program,
      ),
    ),
  );

  return organization;
}

function buildOwnerMember(user) {
  return {
    uid: user.uid,
    email: normalizeEmail(user.email),
    displayName: user.displayName || "",
    photoURL: user.photoURL || "",
    role: "owner",
    roleLevel: 1,
    status: "active",
    branchIds: DEFAULT_BRANCHES.map((branch) => branch.id),
    permissions: OWNER_PERMISSIONS,
    invitedBy: "bootstrap-owner",
    updatedAt: serverTimestamp(),
  };
}

function buildPendingMember(user) {
  return {
    uid: user.uid,
    email: normalizeEmail(user.email),
    displayName: user.displayName || "",
    photoURL: user.photoURL || "",
    role: "pending",
    roleLevel: 4,
    status: "pending",
    branchIds: [],
    permissions: PENDING_PERMISSIONS,
    invitedBy: "self-signup",
    updatedAt: serverTimestamp(),
  };
}

export async function ensureOrganizationMember(user) {
  const db = requireFirestore();
  const memberRef = doc(
    db,
    "organizations",
    DEFAULT_ORG_ID,
    "members",
    user.uid,
  );
  const memberSnapshot = await getDoc(memberRef);
  const owner = isBootstrapOwner(user.email);

  if (memberSnapshot.exists()) {
    const existingMember = {
      id: memberRef.id,
      ...memberSnapshot.data(),
    };

    if (!owner || existingMember.roleLevel === 1) {
      return existingMember;
    }

    const ownerMember = buildOwnerMember(user);
    await setDoc(memberRef, ownerMember, { merge: true });

    return {
      ...existingMember,
      ...ownerMember,
      updatedAt: existingMember.updatedAt || null,
    };
  }

  const member = owner ? buildOwnerMember(user) : buildPendingMember(user);

  await setDoc(memberRef, {
    ...member,
    createdAt: serverTimestamp(),
  });

  return {
    id: memberRef.id,
    ...member,
    createdAt: null,
    updatedAt: null,
  };
}

export async function loadOrganizationWorkspace(user) {
  const profile = await ensureUserProfile(user);
  const member = await ensureOrganizationMember(user);
  const organization = await ensureDefaultOrganization(member);
  const [branches, programs] = await Promise.all([
    listSubcollection(["organizations", DEFAULT_ORG_ID, "branches"]),
    listSubcollection(["organizations", DEFAULT_ORG_ID, "programs"]),
  ]);
  const allowedBranchIds = new Set(member.branchIds || []);
  const canViewAllBranches =
    member.permissions?.canViewAllBranches || member.roleLevel === 1;
  const visibleBranches = canViewAllBranches
    ? branches
    : branches.filter((branch) => allowedBranchIds.has(branch.id));

  return {
    profile,
    organization,
    member,
    branches,
    visibleBranches,
    programs,
  };
}
