const users = new Map();
let nextId = 1;

export function getUser(id) {
  return users.get(Number(id)) || null;
}

export function createUser(data) {
  const id = nextId++;
  const user = { id, ...data };
  users.set(id, user);
  return user;
}
