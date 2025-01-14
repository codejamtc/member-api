/**
 * This service provides operations of member traits.
 */

const _ = require('lodash')
const Joi = require('joi')
const config = require('config')
const moment = require('moment')
const helper = require('../common/helper')
const logger = require('../common/logger')
const errors = require('../common/errors')
const constants = require('../../app-constants')

const esClient = helper.getESClient()

const TRAIT_IDS = ['basic_info', 'education', 'work', 'communities', 'languages', 'hobby', 'organization', 'device', 'software', 'service_provider', 'subscription', 'personalization', 'connect_info']

const TRAIT_FIELDS = ['userId', 'traitId', 'categoryName', 'traits', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy']

/**
 * Get member traits.
 * @param {String} handle the member handle
 * @param {Object} query the query parameters
 * @returns {Object} the member traits
 */
async function getTraits (currentUser, handle, query) {
  // get member
  const member = await helper.getMemberByHandle(handle)
  // parse query parameters
  const traitIds = helper.parseCommaSeparatedString(query.traitIds, TRAIT_IDS) || TRAIT_IDS
  const fields = helper.parseCommaSeparatedString(query.fields, TRAIT_FIELDS) || TRAIT_FIELDS
  // check authorization
  if (!helper.canManageMember(currentUser, member)) {
    throw new errors.ForbiddenError('You are not allowed to view traits of the member.')
  }
  // query member traits from Elasticsearch
  // construct ES query
  const esQuery = {
    index: config.ES.MEMBER_TRAIT_ES_INDEX,
    type: config.ES.MEMBER_TRAIT_ES_TYPE,
    size: constants.ES_SEARCH_MAX_SIZE, // use a large size to query all records
    body: {
      query: {
        bool: {
          filter: [{ match_phrase: { userId: member.userId } }]
        }
      },
      sort: [{ traitId: { order: 'asc' } }]
    }
  }
  // Search with constructed query
  const docs = await esClient.search(esQuery)
  let result = _.map(docs.hits.hits, (item) => item._source)
  // keep only those of given trait ids
  if (traitIds) {
    result = _.filter(result, (item) => _.includes(traitIds, item.traitId))
  }
  // convert date time for traits data
  _.filter(result, (item) => _.forEach(item.traits.data, function (value) {
    if (value.hasOwnProperty('birthDate')) {
      if (value.birthDate) {
        value.birthDate = moment(value.birthDate).toDate().toISOString()
      }
    }
    if (value.hasOwnProperty('memberSince')) {
      if (value.memberSince) {
        value.memberSince = moment(value.memberSince).toDate().toISOString()
      }
    }
    if (value.hasOwnProperty('timePeriodFrom')) {
      if (value.timePeriodFrom) {
        value.timePeriodFrom = moment(value.timePeriodFrom).toDate().toISOString()
      }
    }
    if (value.hasOwnProperty('timePeriodTo')) {
      if (value.timePeriodTo) {
        value.timePeriodTo = moment(value.timePeriodTo).toDate().toISOString()
      }
    }
  }))
  // return only selected fields
  result = _.map(result, (item) => _.pick(item, fields))
  // remove identifiable info fields if user is not admin, not M2M and not member himself
  if (!helper.canManageMember(currentUser, member)) {
    result = _.map(result, (item) => _.omit(item, config.MEMBER_TRAIT_SECURE_FIELDS))
  }
  return result
}

getTraits.schema = {
  currentUser: Joi.any(),
  handle: Joi.string().required(),
  query: Joi.object().keys({
    traitIds: Joi.string(),
    fields: Joi.string()
  })
}

/**
 * Create member traits.
 * @param {Object} currentUser the user who performs operation
 * @param {String} handle the member handle
 * @param {Array} data the member traits data to be created
 * @returns {Array} the created member traits
 */
async function createTraits (currentUser, handle, data) {
  const member = await helper.getMemberByHandle(handle)
  // check authorization
  if (!helper.canManageMember(currentUser, member)) {
    throw new errors.ForbiddenError('You are not allowed to create traits of the member.')
  }
  // get existing traits
  const existingTraits = await helper.query('MemberTrait', { userId: { eq: member.userId } })
  // check if there is any conflict
  _.forEach(data, (item) => {
    if (_.find(existingTraits, (existing) => existing.traitId === item.traitId)) {
      throw new errors.BadRequestError(`The trait id ${item.traitId} already exists for the member.`)
    }
  })
  // create traits
  const result = []
  for (let i = 0; i < data.length; i += 1) {
    const trait = data[i]
    trait.userId = member.userId
    trait.createdAt = new Date().toISOString()
    trait.createdBy = Number(currentUser.userId || currentUser.sub)
    if (trait.traits) {
      trait.traits = { 'traitId': trait.traitId, 'data': trait.traits.data }
    } else {
      trait.traits = { 'traitId': trait.traitId, 'data': [] }
    }
    // update db
    await helper.create('MemberTrait', trait)
    // convert date time
    trait.createdAt = new Date(trait.createdAt).getTime()
    // post bus event
    await helper.postBusEvent(constants.TOPICS.MemberTraitCreated, trait)
    // cleanup sensitive traits
    result.push(_.omit(trait, ['userId']))
  }
  return result
}

createTraits.schema = {
  currentUser: Joi.any(),
  handle: Joi.string().required(),
  data: Joi.array().items(Joi.object().keys({
    traitId: Joi.string().valid(TRAIT_IDS).required(),
    categoryName: Joi.string(),
    traits: Joi.object().keys({
      traitId: Joi.string().valid(TRAIT_IDS),
      data: Joi.array().items(Joi.object())
    })
  }).required()).min(1).required()
}

/**
 * Update member traits.
 * @param {Object} currentUser the user who performs operation
 * @param {String} handle the member handle
 * @param {Array} data the member traits data to be updated
 * @returns {Array} the updated member traits
 */
async function updateTraits (currentUser, handle, data) {
  const member = await helper.getMemberByHandle(handle)
  // check authorization
  if (!helper.canManageMember(currentUser, member)) {
    throw new errors.ForbiddenError('You are not allowed to update traits of the member.')
  }
  // get existing traits
  const existingTraits = await helper.query('MemberTrait', { userId: { eq: member.userId } })
  // check if any trait is not found
  _.forEach(data, (item) => {
    if (!_.find(existingTraits, (existing) => existing.traitId === item.traitId)) {
      throw new errors.NotFoundError(`The trait id ${item.traitId} is not found for the member.`)
    }
  })
  // update traits
  const result = []
  for (let i = 0; i < data.length; i += 1) {
    const trait = data[i]
    const existing = _.find(existingTraits, (e) => e.traitId === trait.traitId)
    if (trait.categoryName) {
      existing.categoryName = trait.categoryName
    }
    existing.updatedAt = new Date().toISOString()
    existing.updatedBy = Number(currentUser.userId || currentUser.sub)
    if (trait.traits) {
      existing.traits = { 'traitId': trait.traitId, 'data': trait.traits.data }
    } else {
      existing.traits = { 'traitId': trait.traitId, 'data': [] }
    }
    // update db
    var updateDb = await helper.update(existing, {})
    // convert date time
    const origUpdateDb = updateDb.originalItem()
    origUpdateDb.createdAt = new Date(origUpdateDb.createdAt).getTime()
    origUpdateDb.updatedAt = new Date(origUpdateDb.updatedAt).getTime()
    // post bus event
    await helper.postBusEvent(constants.TOPICS.MemberTraitUpdated, origUpdateDb)
    // cleanup sensitive traits
    result.push(_.omit(origUpdateDb, ['userId']))
  }
  return result
}

updateTraits.schema = createTraits.schema

/**
 * Remove member traits. If traitIds query parameter is not provided, then all member traits are removed.
 * @param {Object} currentUser the user who performs operation
 * @param {String} handle the member handle
 * @param {Object} query the query parameters
 */
async function removeTraits (currentUser, handle, query) {
  // parse trait ids
  const traitIds = helper.parseCommaSeparatedString(query.traitIds, TRAIT_IDS) || TRAIT_IDS
  const member = await helper.getMemberByHandle(handle)
  // check authorization
  if (!helper.canManageMember(currentUser, member)) {
    throw new errors.ForbiddenError('You are not allowed to remove traits of the member.')
  }
  // get existing traits
  const existingTraits = await helper.query('MemberTrait', { userId: { eq: member.userId } })
  // check if any given trait id is not found
  _.forEach(traitIds || [], (id) => {
    if (!_.find(existingTraits, (existing) => existing.traitId === id)) {
      throw new errors.NotFoundError(`The trait id ${id} is not found for the member.`)
    }
  })
  // remove traits
  const memberProfileTraitIds = []
  for (let i = 0; i < existingTraits.length; i += 1) {
    const trait = existingTraits[i]
    if (!traitIds || _.includes(traitIds, trait.traitId)) {
      memberProfileTraitIds.push(trait.traitId)
      await trait.delete()
    }
  }
  // post bus event
  if (memberProfileTraitIds.length > 0) {
    await helper.postBusEvent(constants.TOPICS.MemberTraitDeleted, {
      userId: member.userId,
      memberProfileTraitIds,
      updatedAt: new Date(),
      updatedBy: currentUser.userId || currentUser.sub
    })
  }
}

removeTraits.schema = {
  currentUser: Joi.any(),
  handle: Joi.string().required(),
  query: Joi.object().keys({
    traitIds: Joi.string() // if not provided, then all member traits are removed
  })
}

module.exports = {
  getTraits,
  createTraits,
  updateTraits,
  removeTraits
}

logger.buildService(module.exports)
