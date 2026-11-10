
# Step 1


## How you explored the data before deciding anything, and what you noticed.
  From reading the CSV file:
  1. One action by one user creates several time stamps => User -> series of time stamps -> Record ID(same) 

    "User C did update serveral fields on 02-27-2026 13:00:31 PM"

  2. Two user can interact with the system at the same time. 
    So it's better in group by USER -> Time -> Record IDs(unreadable), Record(Readable)
  
  3. Using Claude noticed following patterns:
    User A: a third of activity falls between 00:00 and 05:00, and 14% on weekends, so it’s mostly machine activity.
    
    User B: 92% falls between 12:00 and 17:00 with no weekends, which looks like a person working office hours who uses big CSV imports (13.9k rows).
    
    User C: 45% between 00:00 and 05:00, which fits the overnight SFTP job.
    
    User D: 18 rows in office hours, so a person.
  

## How you defined a group, and the trade-offs: groups that are too large hide things, and groups that are too small make the review impossible.
  1. My fisrt approach is to divide groups in chronological orders.
     #DROPPED
    
    02/2026 User C activities(Y/N): 
      TIME 1 (Record Type) Record #Record ID  APPROVE (Y/N) [add note?]
        Created Name (check mark)
        Set xxxx (check mark)
        Field Name update: xxxx -> yyyy (check mark)
        Unset xxxx (check mark)
        [Summary]
      
      TIME 2 (Record Type) Record #Record ID  APPROVE (Y/N) [add note?]
        Field Name update: xxxx -> yyyy (check mark)
        [Summary]
   Which receated too fine grouping with still thousands of groups, makes it hard to review.

  2.
  

     

## What a reviewer needs in order to make a decision, and how your interface supports it.
 Decide to update logic to the prioritize events based on two bases. 
  
For manual inputs involves role change and financial. High Priority.

For automated events, checks when the automation pattern changes. As a change of script would impact the most or is when unauthorized event happens.   

My interface will mark the abvoe actions as risk and allow user to review these changes.

Routine updates/or repeating actions are marked as low risk and are able to be bulk approved.

# Step 2


## Work Flow:

Import, review, update, export.

Functional Requirements:

  1. Import:
    1.1: User able to load CSV into the App.
    1.2: App creates an addtional column to for the case status(Pending, Approved, Denied). Default all empty status into Not Reviewed.

  2. Review and update:
    2.1: App auto categorize all events.
    2.2: User can flag events as Approved or Denied.
    2.4: User can comment on cases.
    2.5: User can search events based on 
      Date	Name	Role	Context	Record Type	Record ID	Record Type	Field	Old Value	New Value	Line Id	Line Transaction Id
  
  3. Export:
    3.1: User can export updated CSV.
    3.2: User can export only part of the CSV based on Date and Names and case statuses.
  
Non-functional Requirements:

  1. App can load 100k+ rows without crashing.

## Building reviewer