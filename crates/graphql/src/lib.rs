// Proving the async-graphql resolvers `Send` walks every future they await, down through
// reqwest and h2 for the metadata providers, and that outgrows the default limit (core
// raises it for the same reason)
#![recursion_limit = "256"]

pub mod data;
pub mod error_message;
pub mod filter;
pub mod guard;
pub mod input;
pub mod loader;
pub mod mutation;
pub mod object;
pub mod order;
pub mod pagination;
pub mod query;
pub mod schema;
pub mod subscription;
pub(crate) mod utils;

#[cfg(test)]
mod tests;

// TODO: Look into https://async-graphql.github.io/async-graphql/en/extensions_available.html#tracing
// TODO: Look into https://async-graphql.github.io/async-graphql/en/extensions_available.html#apollo-persisted-queries
// TODO: Look into data loaders: https://async-graphql.github.io/async-graphql/en/dataloader.html
