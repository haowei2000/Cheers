UPDATE channel_memberships
        SET role = $3, projected_from = NULL
      WHERE channel_id = $1 AND member_id = $2 AND member_type = 'user'
