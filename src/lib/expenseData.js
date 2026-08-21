import {
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";
import { DEFAULT_ORG_ID } from "./orgData";
import { realtimeFirestore } from "./realtimeFirestore";

const requireFirestore = () => {
  if (!realtimeFirestore) {
    throw new Error("Firebase 尚未設定完成，無法儲存雜項支出。");
  }

  return realtimeFirestore;
};

const getBranchExpensesCollection = (db, orgId, branchId) =>
  collection(db, "organizations", orgId, "branches", branchId, "expenses");

const normalizeExpenseItemName = (name) =>
  String(name || "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, "")
    .toLowerCase();

const buildBranchSnapshot = (branch) => ({
  id: branch?.id || "",
  name: branch?.name || "",
  shortName: branch?.shortName || "",
});

const parseAmount = (value) => {
  const numberValue = Number(value);

  return Number.isFinite(numberValue) ? Math.round(numberValue) : 0;
};

const todayDateValue = () => {
  const now = new Date();

  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(
    2,
    "0",
  )}-${String(now.getDate()).padStart(2, "0")}`;
};

const sortExpenses = (records) =>
  [...records].sort((first, second) => {
    const dateCompare = String(second.expenseDate || "").localeCompare(
      String(first.expenseDate || ""),
    );

    if (dateCompare !== 0) {
      return dateCompare;
    }

    return String(second.createdAtIso || "").localeCompare(
      String(first.createdAtIso || ""),
    );
  });

export async function createBranchExpense({
  amount,
  branch,
  createdBy = {},
  expenseDate = "",
  itemName,
  orgId = DEFAULT_ORG_ID,
}) {
  const cleanItemName = String(itemName || "").trim();
  const normalizedAmount = parseAmount(amount);
  const cleanExpenseDate = String(expenseDate || todayDateValue()).trim();

  if (!branch?.id) {
    throw new Error("請先選擇分校。");
  }

  if (!cleanItemName) {
    throw new Error("請輸入支出項目。");
  }

  if (normalizedAmount <= 0) {
    throw new Error("支出金額必須大於 0。");
  }

  const db = requireFirestore();
  const expenseRef = doc(getBranchExpensesCollection(db, orgId, branch.id));
  const createdAtIso = new Date().toISOString();
  const expense = {
    amount: normalizedAmount,
    branchId: branch.id,
    branchSnapshot: buildBranchSnapshot(branch),
    createdAtIso,
    createdByEmail: createdBy.email || "",
    createdByName: createdBy.displayName || createdBy.email || "",
    createdByUid: createdBy.uid || "",
    expenseDate: cleanExpenseDate,
    id: expenseRef.id,
    itemName: cleanItemName,
    normalizedItemName: normalizeExpenseItemName(cleanItemName),
    source: "daily-ledger-expense",
    status: "active",
  };

  await setDoc(expenseRef, {
    ...expense,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  return expense;
}

export function subscribeBranchExpenses({
  branchId = "",
  onChange,
  onError,
  orgId = DEFAULT_ORG_ID,
}) {
  if (!branchId) {
    onChange([]);

    return () => {};
  }

  const db = requireFirestore();
  const expensesQuery = query(
    getBranchExpensesCollection(db, orgId, branchId),
    orderBy("expenseDate", "desc"),
  );

  return onSnapshot(
    expensesQuery,
    { includeMetadataChanges: true },
    (snapshot) => {
      onChange(
        sortExpenses(
          snapshot.docs.map((record) => ({
            id: record.id,
            ...record.data(),
            metadata: {
              fromCache: snapshot.metadata?.fromCache || false,
              hasPendingWrites: snapshot.metadata?.hasPendingWrites || false,
            },
          })),
        ),
      );
    },
    (error) => {
      if (onError) {
        onError(error);
      }
    },
  );
}
