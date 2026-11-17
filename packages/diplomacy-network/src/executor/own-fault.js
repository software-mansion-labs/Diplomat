// Why a job was not started, when the cause is this machine's own - its engine, its
// image, its checkout, its reach to the repository - and nothing of the job had run. A
// start that fails any other way may be the doing of the requester's jobs: one that
// shares the container can end it, or break what a start needs in it.

export class OwnFault extends Error {
  name = 'OwnFault';
}

/// `promise`, with a rejection of it made an OwnFault that says the same.
export const own = (promise) => promise.catch((e) => { throw new OwnFault(e.message, { cause: e }); });
