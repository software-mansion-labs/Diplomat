// A job start that failed for this machine's own reason (engine, image, checkout, reach
// to the repository) before any of the job ran. Any other start failure may be the
// requester's doing: a job sharing the container can end it or break what a start needs.

export class OwnFault extends Error {
  name = 'OwnFault';
}

export const own = (promise) => promise.catch((e) => { throw new OwnFault(e.message, { cause: e }); });
