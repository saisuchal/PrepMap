import { hash } from "bcrypt";
import { db, usersTable } from "../../artifacts/api-server/src/db";

const DEFAULT_PASSWORD = "1234567890";

const TEST_STUDENTS = [
  { id: "test-cdu", universityId: "uni1" },
  { id: "test-nriit", universityId: "uni2" },
  { id: "test-mrv", universityId: "uni3" },
  { id: "test-nsrit", universityId: "uni4" },
  { id: "test-takshashila", universityId: "uni5" },
  { id: "test-bits-hyd", universityId: "uni6" },
  { id: "test-ciet", universityId: "uni7" },
  { id: "test-aurora", universityId: "uni8" },
  { id: "test-adypu", universityId: "uni9" },
  { id: "test-vgu", universityId: "uni10" },
  { id: "test-niu", universityId: "uni11" },
  { id: "test-s-vyasa", universityId: "uni12" },
  { id: "test-amet", universityId: "uni13" },
  { id: "test-crescent", universityId: "uni14" },
  { id: "test-sgu", universityId: "uni15" },
  { id: "test-annamacharya", universityId: "uni16" },
  { id: "test-chalapathi", universityId: "uni17" },
  { id: "test-yenepoya", universityId: "uni18" },
] as const;

async function seedTestStudents() {
  console.log("Seeding test students...");
  const hashedPassword = await hash(DEFAULT_PASSWORD, 10);

  for (const student of TEST_STUDENTS) {
    await db
      .insert(usersTable)
      .values({
        id: student.id,
        universityId: student.universityId,
        branch: "CSE",
        year: "sem1",
        role: "super_student",
        password: hashedPassword,
      })
      .onConflictDoUpdate({
        target: usersTable.id,
        set: {
          universityId: student.universityId,
          branch: "CSE",
          year: "sem1",
          role: "super_student",
          password: hashedPassword,
        },
      });
  }

  console.log(`Done. Upserted ${TEST_STUDENTS.length} test students.`);
  process.exit(0);
}

seedTestStudents().catch((err) => {
  console.error("Failed to seed test students:", err);
  process.exit(1);
});

